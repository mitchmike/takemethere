import type { FastifyInstance } from 'fastify';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { pool } from '../db/client.js';
import { redis } from '../redis/client.js';
import { startPoller, stopPoller, getPollerStatus } from '../stream/ingest/ptv_poller.js';
import { replayController } from '../stream/ingest/replay.js';
import { startStreamer, stopStreamer } from '../stream/output/emitter.js';
import { setRouteLineMap, setLineStopCoords, setGlobalStopNames, setDwellStats } from '../stream/engine/static_data.js';
import { getPrevNextStopNames } from '../stream/engine/static_data.js';
import { loadPatronageData, loadDwellStatsFromDb } from '../gtfs-static/patronage-loader.js';
import { loadLineShapes } from '../gtfs-static/shapes-loader.js';
import { getDataFreshness, markLoaded } from '../gtfs-static/freshness.js';
import { getLines } from '../db/queries/lines.js';
import type { LivePosition } from '@takemethere/shared';
import type { Server } from 'socket.io';

const workerPath = fileURLToPath(new URL('../gtfs-static/loader-worker.ts', import.meta.url));

type LoadStep = { step: string; count?: number; done: boolean };

const loadState = {
  loading: false,
  lastLoadAt: null as string | null,
  lastError: null as string | null,
  steps: [] as LoadStep[],
  currentStep: null as string | null,
};

const STEP_LABELS: Record<string, string> = {
  downloading: 'Downloading GTFS zip',
  routes: 'Routes',
  stops: 'Stops',
  trips: 'Trips',
  stop_times: 'Stop times (slowest step)',
  view: 'Refreshing station order view',
  done: 'Complete',
};

async function reloadMaps(): Promise<void> {
  const [routeRows, lines, stopRows] = await Promise.all([
    pool.query<{ route_id: string; line_id: string }>(
      `SELECT route_id, line_id FROM routes WHERE line_id IS NOT NULL AND route_type = 400`
    ).then(r => r.rows),
    getLines(),
    pool.query<{ stop_id: string; stop_name: string }>(`SELECT stop_id, stop_name FROM stops`).then(r => r.rows),
  ]);
  setRouteLineMap(new Map(routeRows.map(r => [r.route_id, r.line_id])));
  setLineStopCoords(new Map(lines.map(line => [
    line.lineId,
    line.stops.map(s => ({ stopId: s.stopId, stopName: s.stopName, canonicalX: s.canonicalX, lat: s.stopLat, lon: s.stopLon })),
  ])));
  setGlobalStopNames(new Map(stopRows.map(r => [r.stop_id, r.stop_name])));
  console.log(`[admin] Reloaded ${routeRows.length} routes, ${lines.length} line geometries, ${stopRows.length} stop names`);
}

function spawnLoaderWorker(): void {
  loadState.steps = [];
  loadState.currentStep = 'downloading';

  const worker = new Worker(workerPath, { execArgv: ['--import', 'tsx/esm'] });

  worker.on('message', (msg: { progress?: string; count?: number; done?: boolean; error?: string }) => {
    if (msg.progress) {
      const prev = loadState.steps.find(s => s.step === loadState.currentStep);
      if (prev) prev.done = true;

      if (msg.count !== undefined) {
        const existing = loadState.steps.find(s => s.step === msg.progress);
        if (existing) { existing.count = msg.count; existing.done = true; }
        else loadState.steps.push({ step: msg.progress!, count: msg.count, done: true });
        loadState.currentStep = null;
      } else {
        loadState.currentStep = msg.progress!;
        if (!loadState.steps.find(s => s.step === msg.progress)) {
          loadState.steps.push({ step: msg.progress!, done: false });
        }
      }
    }
    if (msg.done) {
      loadState.loading = false;
      loadState.lastLoadAt = new Date().toISOString();
      loadState.currentStep = null;
      reloadMaps().catch(err => console.error('[admin] Failed to reload maps:', err));
      markLoaded(pool, 'gtfs_static').catch(() => { /* migration 003 may not exist yet */ });
    }
    if (msg.error) {
      loadState.loading = false;
      loadState.lastError = msg.error;
      loadState.currentStep = null;
    }
  });

  worker.on('error', ({message}) => {
    loadState.loading = false;
    loadState.lastError = message;
    loadState.currentStep = null;
  });
}

const STAT_TABLES = ['routes', 'stops', 'trips', 'stop_times', 'line_station_order'] as const;

async function getTableCounts(): Promise<{ table: string; count: number }[]> {
  const results = await Promise.all(STAT_TABLES.map(async t => {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    return { table: t, count: rows[0].n as number };
  }));
  return STAT_TABLES.map(t => results.find(r => r.table === t)!);
}

function getSocketStats(io: Server) {
  const rooms = io.sockets.adapter.rooms;
  const lineRooms: { room: string; subscribers: number }[] = [];
  for (const [room, sockets] of rooms) {
    if (room.startsWith('line:')) {
      lineRooms.push({ room, subscribers: sockets.size });
    }
  }
  return {
    connectedClients: io.sockets.sockets.size,
    lineRooms: lineRooms.sort((a, b) => b.subscribers - a.subscribers),
  };
}

export async function adminRoutes(fastify: FastifyInstance, { io }: { io: Server }): Promise<void> {
  fastify.get('/admin/status', async (_req, reply) => {
    const [tableCounts, rt] = await Promise.all([getTableCounts(), getPollerStatus()]);
    return reply.send({
      gtfsStatic: { ...loadState, counts: tableCounts },
      gtfsRt: rt,
      socket: getSocketStats(io),
    });
  });

  fastify.post('/admin/gtfs-rt/start', async (_req, reply) => {
    startPoller(io);
    startStreamer(io);
    return reply.send({ ok: true, status: getPollerStatus() });
  });

  fastify.post('/admin/gtfs-rt/stop', async (_req, reply) => {
    stopPoller();
    stopStreamer();
    return reply.send({ ok: true, status: getPollerStatus() });
  });

  fastify.get('/admin/rt/vehicles', async (_req, reply) => {
    const redisKeys = await redis.keys('vehicle:*');
    const raw = redisKeys.length > 0 ? await redis.mget(...redisKeys) : [];
    const nowEpoch = Date.now() / 1000;

    const vehicles = raw
      .filter((v): v is string => v !== null)
      .map(v => {
        const pos = JSON.parse(v) as LivePosition;
        const { prevStopName, nextStopName } = getPrevNextStopNames(
          pos.lineId, pos.canonicalX, pos.nextStopId,
        );

        // Estimated position between prev and next stop — mirrors streamer logic
        const arrivalEpoch = pos.predictedNextArrivalEpoch > 0
          ? pos.predictedNextArrivalEpoch
          : pos.nextArrivalEpoch;
        let estimatedPct: number | null = null;
        if (arrivalEpoch > pos.timestamp && pos.nextStopCanonicalX >= 0 && pos.nextStopCanonicalX !== pos.canonicalX) {
          const elapsed = nowEpoch - pos.timestamp;
          const total = arrivalEpoch - pos.timestamp;
          if (total > 0) {
            const t = Math.min(1, Math.max(0, elapsed / total));
            estimatedPct = Math.round(t * 100);
          }
        }

        return {
          ...pos,
          prevStopName,
          nextStopName,
          estimatedPct,       // % of way from prev to next stop (null if no TU data)
          ageSec: Math.round(nowEpoch - pos.timestamp),
        };
      })
      .sort((a, b) => a.lineId.localeCompare(b.lineId) || a.tripId.localeCompare(b.tripId));

    return reply.send({ vehicles, total: vehicles.length });
  });

  fastify.post('/admin/gtfs-static/reload', async (_req, reply) => {
    if (loadState.loading) return reply.code(409).send({ error: 'Load already in progress' });
    loadState.loading = true;
    loadState.lastError = null;
    reply.send({ ok: true, message: 'Load started' });
    spawnLoaderWorker();
  });

  // ── Patronage / dwell endpoints ──────────────────────────────────────────────

  const patronageState = {
    loading: false,
    lastLoadAt: null as string | null,
    lastError: null as string | null,
    log: [] as string[],
  };

  fastify.post('/admin/patronage/load', async (_req, reply) => {
    if (patronageState.loading) return reply.code(409).send({ error: 'Load already in progress' });
    patronageState.loading = true;
    patronageState.lastError = null;
    patronageState.log = [];
    reply.send({ ok: true, message: 'Patronage load started' });

    loadPatronageData(pool, msg => {
      patronageState.log.push(msg);
      console.log('[patronage]', msg);
    })
      .then(async () => {
        patronageState.lastLoadAt = new Date().toISOString();
        patronageState.loading = false;
        const dwell = await loadDwellStatsFromDb(pool);
        setDwellStats(dwell);
        await markLoaded(pool, 'patronage').catch(() => { /* migration 003 may not exist yet */ });
        console.log(`[patronage] Done. Loaded dwell stats for ${dwell.size} stops.`);
      })
      .catch((err: Error) => {
        patronageState.lastError = err.message;
        patronageState.loading = false;
        console.error('[patronage] Failed:', err.message);
      });
  });

  fastify.get('/admin/patronage/status', async (_req, reply) => {
    return reply.send(patronageState);
  });

  fastify.get('/admin/patronage/dwell', async (req, reply) => {
    const lineId = (req.query as Record<string, string>).line;
    const query = lineId
      ? `SELECT sds.stop_id, s.stop_name, sds.lines_at_stop, sds.per_line_pax_annual,
                sds.busyness_score, sds.base_dwell_sec, sds.peak_dwell_sec, sds.offpeak_dwell_sec,
                sds.peak_gap_sec, sds.offpeak_gap_sec, sds.computed_at
         FROM stop_dwell_stats sds
         JOIN stops s ON s.stop_id = sds.stop_id
         WHERE sds.line_id = $1
         ORDER BY sds.busyness_score DESC`
      : `SELECT sds.stop_id, s.stop_name, sds.line_id, sds.lines_at_stop, sds.per_line_pax_annual,
                sds.busyness_score, sds.base_dwell_sec, sds.peak_dwell_sec, sds.offpeak_dwell_sec,
                sds.computed_at
         FROM stop_dwell_stats sds
         JOIN stops s ON s.stop_id = sds.stop_id
         ORDER BY sds.busyness_score DESC
         LIMIT 50`;

    const { rows } = await pool.query(query, lineId ? [lineId] : []);
    const { rows: patRows } = await pool.query(
      `SELECT COUNT(*)::int AS matched, MAX(data_year) AS year, MAX(loaded_at) AS loaded_at FROM station_patronage`
    );
    return reply.send({ rows, patronageMeta: patRows[0] });
  });

  // ── Line shapes endpoints ────────────────────────────────────────────────────

  const shapesState = {
    loading: false,
    lastLoadAt: null as string | null,
    lastError: null as string | null,
    log: [] as string[],
  };

  fastify.post('/admin/shapes/load', async (_req, reply) => {
    if (shapesState.loading) return reply.code(409).send({ error: 'Load already in progress' });
    shapesState.loading = true;
    shapesState.lastError = null;
    shapesState.log = [];
    reply.send({ ok: true, message: 'Shape load started' });

    loadLineShapes(pool, msg => {
      shapesState.log.push(msg);
      console.log('[shapes]', msg);
    })
      .then(async () => {
        shapesState.lastLoadAt = new Date().toISOString();
        shapesState.loading = false;
        await markLoaded(pool, 'line_shapes').catch(() => { /* migration 003 may not exist yet */ });
        console.log('[shapes] Done.');
      })
      .catch((err: Error) => {
        shapesState.lastError = err.message;
        shapesState.loading = false;
        console.error('[shapes] Failed:', err.message);
      });
  });

  fastify.get('/admin/shapes/status', async (_req, reply) => {
    return reply.send(shapesState);
  });

  // ── Data freshness endpoint ──────────────────────────────────────────────────

  fastify.get('/admin/data-freshness', async (_req, reply) => {
    try {
      const freshness = await getDataFreshness(pool);
      const { rows: shapeCounts } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM line_shapes`
      ).catch(() => ({ rows: [{ count: '0' }] }));
      return reply.send({
        entities: [...freshness.values()].map(r => ({
          ...r,
          lastLoadedAt: r.lastLoadedAt?.toISOString() ?? null,
        })),
        lineShapeCount: parseInt(shapeCounts[0]?.count ?? '0'),
      });
    } catch {
      return reply.send({ entities: [], lineShapeCount: 0 });
    }
  });

  // ── Replay endpoints ─────────────────────────────────────────────────────────

  fastify.get('/admin/replay/sessions', async (_req, reply) => {
    const sessions = await replayController.listSessions();
    return reply.send({ sessions });
  });

  fastify.post('/admin/replay/start', async (req, reply) => {
    const { session, speed } = req.body as { session?: string; speed?: number };
    if (!session) return reply.code(400).send({ error: 'session required' });
    if (replayController.getStatus().active) return reply.code(409).send({ error: 'Replay already active' });
    stopPoller();
    stopStreamer();
    replayController.start(session, io, speed ?? 1).catch(err =>
      console.error('[replay] Start failed:', (err as Error).message)
    );
    return reply.send({ ok: true, status: replayController.getStatus() });
  });

  fastify.post('/admin/replay/stop', async (_req, reply) => {
    replayController.stop();
    io.emit('mode:update', { mode: 'live' });
    return reply.send({ ok: true });
  });

  fastify.get('/admin/replay/status', async (_req, reply) => {
    return reply.send(replayController.getStatus());
  });

  fastify.get('/admin', async (_req, reply) => {
    reply.type('text/html').send(adminHtml());
  });
}

function adminHtml(): string {
  const stepLabels = JSON.stringify(STEP_LABELS);
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TakeMeThere Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 2rem; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.5rem; color: #fff; }
    h2 { font-size: 0.85rem; font-weight: 600; margin-bottom: 1rem; color: #888; text-transform: uppercase; letter-spacing: 0.06em; }
    h3 { font-size: 0.78rem; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin: 1rem 0 0.4rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; max-width: 1200px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1.5rem; }
    .card-wide { grid-column: 1 / -1; }
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0; border-bottom: 1px solid #222; font-size: 0.85rem; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #777; }
    .stat-value { font-variant-numeric: tabular-nums; font-size: 0.85rem; }
    .badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 4px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.03em; }
    .badge-green { background: #14532d; color: #4ade80; }
    .badge-red   { background: #450a0a; color: #f87171; }
    .badge-gray  { background: #27272a; color: #71717a; }
    .delta-pos { color: #4ade80; font-size: 0.72rem; font-weight: 700; margin-left: 0.3rem; }
    .delta-neg { color: #f87171; font-size: 0.72rem; font-weight: 700; margin-left: 0.3rem; }
    .btn { display: inline-block; padding: 0.45rem 1.1rem; border-radius: 6px; border: none; cursor: pointer; font-size: 0.85rem; font-weight: 500; margin-top: 1rem; margin-right: 0.5rem; }
    .btn-green { background: #166534; color: #fff; } .btn-green:hover { background: #15803d; }
    .btn-red   { background: #7f1d1d; color: #fff; } .btn-red:hover   { background: #991b1b; }
    .btn-blue  { background: #1e3a5f; color: #fff; } .btn-blue:hover  { background: #1d4ed8; }
    .btn-sm { padding: 0.25rem 0.65rem; font-size: 0.78rem; margin-top: 0; }
    .btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .error { color: #f87171; font-size: 0.8rem; margin-top: 0.75rem; word-break: break-all; }
    .meta  { color: #555; font-size: 0.78rem; margin-top: 0.6rem; }
    #refresh-time { color: #444; font-size: 0.78rem; margin-bottom: 1.5rem; }
    .steps { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.25rem; }
    .step { display: flex; align-items: center; gap: 0.55rem; font-size: 0.83rem; }
    .step-icon { width: 1rem; text-align: center; flex-shrink: 0; color: #4ade80; }
    .step-label { color: #aaa; }
    .step-label.active { color: #fff; }
    .step-label.done  { color: #555; }
    .step-count { margin-left: auto; color: #555; font-variant-numeric: tabular-nums; font-size: 0.78rem; }
    .spinner { display: inline-block; width: 0.7rem; height: 0.7rem; border: 2px solid #444; border-top-color: #fb923c; border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .progress-bar-wrap { margin-top: 0.8rem; height: 3px; background: #2a2a2a; border-radius: 2px; }
    .progress-bar { height: 100%; background: #1d4ed8; border-radius: 2px; transition: width 0.5s ease; }
    .empty-note { color: #444; font-size: 0.82rem; margin-top: 0.5rem; }
    .inner-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 2rem; }
    /* Line table */
    .line-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.83rem; }
    .line-table th { text-align: left; color: #555; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.3rem 0.6rem; border-bottom: 1px solid #2a2a2a; }
    .line-table td { padding: 0.35rem 0.6rem; border-bottom: 1px solid #1e1e1e; vertical-align: middle; }
    .line-table tr:last-child td { border-bottom: none; }
    .line-table tr.line-row { cursor: pointer; }
    .line-table tr.line-row:hover td { background: #222; }
    .line-table tr.line-row.selected td { background: #1e2d3d; }
    .expand-arrow { color: #555; font-size: 0.75rem; transition: transform 0.15s; display: inline-block; }
    .expand-arrow.open { transform: rotate(90deg); }
    /* Vehicle inspector panel */
    #inspector-panel { display: none; margin-top: 1.5rem; }
    #inspector-panel.visible { display: block; }
    #inspector-title { font-size: 0.85rem; font-weight: 600; color: #aaa; margin-bottom: 0.75rem; }
    .veh-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .veh-table th { text-align: left; color: #555; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.3rem 0.6rem; border-bottom: 1px solid #2a2a2a; }
    .veh-table td { padding: 0.35rem 0.6rem; border-bottom: 1px solid #1e1e1e; vertical-align: top; font-variant-numeric: tabular-nums; }
    .veh-table tr.veh-row { cursor: pointer; }
    .veh-table tr.veh-row:hover td { background: #1e1e1e; }
    .veh-json-row td { padding: 0; }
    .veh-json { background: #111; border-top: 1px solid #2a2a2a; padding: 0.75rem 1rem; font-family: monospace; font-size: 0.75rem; color: #a5f3fc; white-space: pre; overflow-x: auto; }
    .delay-pos { color: #f87171; }
    .delay-neg { color: #4ade80; }
    .delay-zero { color: #555; }
    .age-fresh { color: #4ade80; }
    .age-old   { color: #f87171; }
    .age-mid   { color: #fb923c; }
    .stale-badge { background: #27272a; color: #71717a; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.7rem; }
  </style>
</head>
<body>
  <h1>TakeMeThere — Admin</h1>
  <p id="refresh-time">Loading…</p>
  <div class="grid">

    <!-- Data Management -->
    <div class="card card-wide" id="data-mgmt-card">
      <h2>Data Management</h2>
      <div id="data-freshness-table"></div>
      <div id="shapes-log" style="font-family:monospace;font-size:0.78rem;color:#888;min-height:0;margin-top:0.75rem;white-space:pre-wrap"></div>
    </div>

    <!-- GTFS Static -->
    <div class="card">
      <h2>GTFS Static</h2>
      <div id="static-steps"></div>
      <div id="static-counts"></div>
      <div id="static-error" class="error"></div>
      <button class="btn btn-blue" id="btn-reload" onclick="reloadStatic()">Load / Reload Data</button>
    </div>

    <!-- GTFS-RT control + poll stats -->
    <div class="card">
      <h2>GTFS-RT Live Feed</h2>
      <div id="rt-core"></div>
      <div id="rt-error" class="error"></div>
      <button class="btn btn-green" id="btn-start" onclick="startRt()">Start Poller</button>
      <button class="btn btn-red"   id="btn-stop"  onclick="stopRt()" disabled>Stop Poller</button>
    </div>

    <!-- RT Vehicle stats (full width) -->
    <div class="card card-wide" id="rt-stats-card" style="display:none">
      <h2>Live Vehicle Data</h2>
      <div class="inner-grid">
        <div>
          <h3>By Line — click to inspect</h3>
          <div id="rt-by-line"></div>
        </div>
        <div>
          <h3>Pipeline</h3>
          <div id="rt-pipeline"></div>
          <h3 style="margin-top:1.2rem">Socket.io</h3>
          <div id="rt-socket"></div>
        </div>
      </div>

      <!-- Vehicle inspector -->
      <div id="inspector-panel">
        <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem">
          <span id="inspector-title"></span>
          <button class="btn btn-blue btn-sm" onclick="refreshInspector()">Refresh</button>
          <button class="btn btn-gray btn-sm" onclick="closeInspector()" style="background:#27272a;color:#aaa">Close</button>
        </div>
        <div id="inspector-content"></div>
      </div>
    </div>

    <!-- Replay -->
    <div class="card card-wide" id="replay-card">
      <h2>Historical Replay</h2>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem">
        <select id="replay-session-select" style="background:#222;color:#ccc;border:1px solid #333;border-radius:5px;padding:0.3rem 0.6rem;font-size:0.83rem">
          <option value="">— Select capture session —</option>
        </select>
        <select id="replay-speed-select" style="background:#222;color:#ccc;border:1px solid #333;border-radius:5px;padding:0.3rem 0.6rem;font-size:0.83rem">
          <option value="1">1× speed</option>
          <option value="2">2× speed</option>
          <option value="5">5× speed</option>
          <option value="10">10× speed</option>
        </select>
        <button class="btn btn-green" id="btn-replay-start" onclick="startReplay()">▶ Start Replay</button>
        <button class="btn btn-red"   id="btn-replay-stop"  onclick="stopReplay()" disabled>■ Stop Replay</button>
      </div>
      <div id="replay-status" class="meta"></div>
      <div id="replay-progress-wrap" class="progress-bar-wrap" style="display:none">
        <div id="replay-progress-bar" class="progress-bar" style="width:0%"></div>
      </div>
      <p class="meta" style="margin-top:0.5rem;color:#555">Note: starting a replay stops the live poller. Stop the replay to resume live data.</p>
    </div>

    <!-- Patronage & Dwell -->
    <div class="card card-wide" id="patronage-card">
      <h2>Station Patronage &amp; Dwell Estimates</h2>
      <div id="patronage-meta" style="font-size:0.82rem;color:#555;margin-bottom:0.75rem"></div>
      <div id="patronage-log" style="font-family:monospace;font-size:0.78rem;color:#888;min-height:20px;margin-bottom:0.75rem;white-space:pre-wrap"></div>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:1rem">
        <button class="btn btn-blue" id="btn-load-patronage" onclick="loadPatronage()">Load / Refresh Patronage</button>
        <select id="dwell-line-select" style="background:#222;color:#ccc;border:1px solid #333;border-radius:5px;padding:0.3rem 0.6rem;font-size:0.83rem" onchange="loadDwellTable()">
          <option value="">— All top-50 stops —</option>
        </select>
      </div>
      <div id="dwell-table-wrap"></div>
    </div>

  </div>

  <script>
    const STEP_LABELS = ${stepLabels};
    const STEP_ORDER = ['downloading','routes','stops','trips','stop_times','view'];

    let activeLineId = null;
    let expandedTripId = null;

    async function fetchStatus() {
      const res = await fetch('/admin/status');
      const data = await res.json();
      renderStatic(data.gtfsStatic);
      renderRt(data.gtfsRt, data.socket);
      document.getElementById('refresh-time').textContent = 'Last refreshed: ' + new Date().toLocaleTimeString();
    }

    function renderStatic(s) {
      const loading = s.loading;
      const steps = s.steps ?? [];
      const currentStep = s.currentStep;
      const hasData = (s.counts ?? []).find(c => c.table === 'stop_times')?.count > 0;

      if (loading || steps.length > 0) {
        const stepsHtml = STEP_ORDER.map(key => {
          const found = steps.find(st => st.step === key);
          const isActive = key === currentStep;
          const isDone = found?.done;
          const icon = isDone ? '✓' : isActive ? '<span class="spinner"></span>' : '<span style="color:#333">·</span>';
          const cls  = isDone ? 'done' : isActive ? 'active' : '';
          const count = found?.count != null ? found.count.toLocaleString() : '';
          return \`<div class="step">
            <span class="step-icon">\${icon}</span>
            <span class="step-label \${cls}">\${STEP_LABELS[key] ?? key}</span>
            \${count ? \`<span class="step-count">\${count}</span>\` : ''}
          </div>\`;
        }).join('');

        const pct = Math.round((steps.filter(st => st.done).length / STEP_ORDER.length) * 100);
        document.getElementById('static-steps').innerHTML =
          \`<div class="steps">\${stepsHtml}</div>
           <div class="progress-bar-wrap"><div class="progress-bar" style="width:\${pct}%"></div></div>
           <p class="meta">\${loading ? 'Loading…' : s.lastLoadAt ? 'Completed: ' + new Date(s.lastLoadAt).toLocaleString() : ''}</p>\`;
        document.getElementById('static-counts').innerHTML = '';
      } else {
        document.getElementById('static-steps').innerHTML = '';
        const meta = s.lastLoadAt
          ? 'Last loaded: ' + new Date(s.lastLoadAt).toLocaleString()
          : hasData ? 'Data present (loaded before this session)' : 'Never loaded';
        document.getElementById('static-counts').innerHTML =
          (s.counts ?? []).map(({ table, count }) =>
            \`<div class="stat-row"><span class="stat-label">\${table}</span><span class="stat-value">\${count.toLocaleString()}</span></div>\`
          ).join('') + \`<p class="meta">\${meta}</p>\`;
      }

      document.getElementById('static-error').textContent = s.lastError ?? '';
      document.getElementById('btn-reload').disabled = loading;
    }

    function renderRt(rt, socket) {
      const badge = rt.running
        ? '<span class="badge badge-green">RUNNING</span>'
        : '<span class="badge badge-red">STOPPED</span>';
      const ps = rt.publishStats ?? {};

      document.getElementById('rt-core').innerHTML =
        \`<div class="stat-row"><span class="stat-label">Status</span><span>\${badge}</span></div>
         <div class="stat-row"><span class="stat-label">Poll interval</span><span class="stat-value">30s</span></div>
         <div class="stat-row"><span class="stat-label">Total polls</span><span class="stat-value">\${rt.pollCount ?? 0}</span></div>
         <div class="stat-row"><span class="stat-label">Last poll</span><span class="stat-value">\${rt.lastPollAt ? new Date(rt.lastPollAt).toLocaleTimeString() : '—'}</span></div>
         <div class="stat-row"><span class="stat-label">Last poll duration</span><span class="stat-value">\${rt.lastPollMs != null ? rt.lastPollMs+'ms' : '—'}</span></div>
         <div class="stat-row"><span class="stat-label">Vehicles in last poll</span><span class="stat-value">\${ps.vehicleCount ?? 0}</span></div>
         <div class="stat-row"><span class="stat-label">Unmapped vehicles</span><span class="stat-value">\${ps.unmappedCount ?? 0}</span></div>
         <div class="stat-row"><span class="stat-label">Trip update matches</span><span class="stat-value">\${ps.tuMatchCount ?? 0} / \${ps.vehicleCount ?? 0}</span></div>\`;

      document.getElementById('rt-error').textContent = rt.lastError ?? '';
      document.getElementById('btn-start').disabled = rt.running;
      document.getElementById('btn-stop').disabled  = !rt.running;

      const statsCard = document.getElementById('rt-stats-card');
      if (!rt.running && (ps.vehicleCount ?? 0) === 0) {
        statsCard.style.display = 'none';
        return;
      }
      statsCard.style.display = '';

      // By-line table with delta indicators
      const byLine = (ps.vehiclesByLine ?? []).sort((a, b) => a.lineId.localeCompare(b.lineId));
      if (byLine.length === 0) {
        document.getElementById('rt-by-line').innerHTML = '<p class="empty-note">No vehicles mapped yet</p>';
      } else {
        const snapshotLabel = ps.snapshotAt
          ? 'Snapshot: ' + new Date(ps.snapshotAt).toLocaleTimeString()
          : '';
        const rows = byLine.map(l => {
          const deltaHtml = l.delta === null ? ''
            : l.delta > 0 ? \`<span class="delta-pos">+\${l.delta}</span>\`
            : l.delta < 0 ? \`<span class="delta-neg">\${l.delta}</span>\`
            : '';
          const isActive = l.lineId === activeLineId;
          return \`<tr class="line-row\${isActive ? ' selected' : ''}" onclick="inspectLine('\${l.lineId}')">
            <td>
              <span class="expand-arrow\${isActive ? ' open' : ''}">▶</span>
              <span style="margin-left:0.4rem;color:#ccc">\${l.lineId}</span>
            </td>
            <td style="text-align:right;color:#ccc;font-variant-numeric:tabular-nums">\${l.count}\${deltaHtml}</td>
          </tr>\`;
        }).join('');
        const total = byLine.reduce((s, l) => s + l.count, 0);
        document.getElementById('rt-by-line').innerHTML =
          \`<table class="line-table">
            <thead><tr><th>Line</th><th style="text-align:right">Poll</th></tr></thead>
            <tbody>\${rows}</tbody>
          </table>
          <p class="meta" style="margin-top:0.5rem">
            \${total} mapped / \${ps.redisVehicleCount ?? 0} in Redis (120s)
            \${snapshotLabel ? ' · ' + snapshotLabel : ''}
          </p>\`;
      }

      // Pipeline stats
      document.getElementById('rt-pipeline').innerHTML =
        \`<div class="stat-row"><span class="stat-label">Redis vehicle keys</span><span class="stat-value">\${ps.redisVehicleCount ?? 0}</span></div>
         <div class="stat-row"><span class="stat-label">Keys expire after</span><span class="stat-value">120s</span></div>\`;

      // Socket stats
      const connectedClients = socket?.connectedClients ?? 0;
      const lineRooms = socket?.lineRooms ?? [];
      const activeRooms = lineRooms.filter(r => r.subscribers > 0);
      document.getElementById('rt-socket').innerHTML =
        \`<div class="stat-row"><span class="stat-label">Connected clients</span><span class="stat-value">\${connectedClients}</span></div>
         <div class="stat-row"><span class="stat-label">Active line rooms</span><span class="stat-value">\${activeRooms.length}</span></div>
         \${activeRooms.map(r =>
           \`<div class="stat-row" style="padding-left:0.75rem"><span class="stat-label" style="font-size:0.78rem">\${r.room}</span><span class="stat-value">\${r.subscribers}</span></div>\`
         ).join('')}
         \${activeRooms.length === 0 ? '<p class="empty-note">No subscribers</p>' : ''}\`;
    }

    // ── Vehicle inspector ─────────────────────────────────────────────────
    async function inspectLine(lineId) {
      if (activeLineId === lineId) { closeInspector(); return; }
      activeLineId = lineId;
      expandedTripId = null;
      document.getElementById('inspector-panel').classList.add('visible');
      document.getElementById('inspector-title').textContent = lineId + ' — loading…';
      document.getElementById('inspector-content').innerHTML = '<p class="empty-note">Fetching from Redis…</p>';
      // Re-render by-line table to update selection highlight
      await fetchStatus();
      await loadInspector();
    }

    async function loadInspector() {
      if (!activeLineId) return;
      const res = await fetch('/admin/rt/vehicles');
      const { vehicles } = await res.json();
      const lineVehicles = vehicles.filter(v => v.lineId === activeLineId);
      const nowEpoch = Date.now() / 1000;

      document.getElementById('inspector-title').textContent =
        activeLineId + ' — ' + lineVehicles.length + ' vehicle' + (lineVehicles.length !== 1 ? 's' : '') + ' in Redis';

      if (lineVehicles.length === 0) {
        document.getElementById('inspector-content').innerHTML = '<p class="empty-note">No vehicles in Redis for this line</p>';
        return;
      }

      const nowEpochMs = Date.now();
      const rows = lineVehicles.map(v => {
        const ageSec = v.ageSec ?? Math.round((nowEpochMs / 1000) - v.timestamp);
        const ageLabel = ageSec < 60 ? ageSec + 's ago' : Math.floor(ageSec/60) + 'm ' + (ageSec%60) + 's ago';
        const ageCls = ageSec < 45 ? 'age-fresh' : ageSec < 90 ? 'age-mid' : 'age-old';
        const delaySec = v.delay ?? 0;
        const delayLabel = delaySec === 0 ? '<span class="delay-zero">on time</span>'
          : delaySec > 0 ? \`<span class="delay-pos">+\${delaySec}s</span>\`
          : \`<span class="delay-neg">\${delaySec}s</span>\`;

        const prevName = (v.prevStopName ?? '—').replace(/ Station$/, '');
        const nextName = (v.nextStopName ?? '—').replace(/ Station$/, '');
        const posLabel = v.estimatedPct != null
          ? \`<span style="color:#ccc">\${prevName}</span><span style="color:#555;font-size:0.72rem"> → \${v.estimatedPct}% → </span><span style="color:#ccc">\${nextName}</span>\`
          : \`<span style="color:#555">\${prevName} → \${nextName}</span>\`;

        const isExpanded = expandedTripId === v.tripId;
        return \`<tr class="veh-row" onclick="toggleVehicle('\${v.tripId}')">
          <td style="color:#aaa;font-size:0.75rem">\${v.tripId}</td>
          <td>\${delayLabel}</td>
          <td style="color:#777">\${v.bearing != null ? Math.round(v.bearing) + '°' : '—'}</td>
          <td>\${posLabel}</td>
          <td class="\${ageCls}">\${ageLabel}</td>
          <td style="color:#555;font-size:0.75rem">\${isExpanded ? '▲' : '▼'}</td>
        </tr>
        \${isExpanded ? \`<tr class="veh-json-row"><td colspan="6"><div class="veh-json">\${JSON.stringify(v, null, 2)}</div></td></tr>\` : ''}\`;
      }).join('');

      document.getElementById('inspector-content').innerHTML =
        \`<table class="veh-table">
          <thead><tr>
            <th>Trip ID</th><th>Delay</th><th>Bearing</th><th>Between stops (est.)</th><th>Last update</th><th></th>
          </tr></thead>
          <tbody>\${rows}</tbody>
        </table>\`;
    }

    function toggleVehicle(tripId) {
      expandedTripId = expandedTripId === tripId ? null : tripId;
      loadInspector();
    }

    async function refreshInspector() {
      await loadInspector();
    }

    function closeInspector() {
      activeLineId = null;
      expandedTripId = null;
      document.getElementById('inspector-panel').classList.remove('visible');
      fetchStatus();
    }

    // ── Polling ───────────────────────────────────────────────────────────
    let pollInterval = null;

    async function reloadStatic() {
      document.getElementById('btn-reload').disabled = true;
      await fetch('/admin/gtfs-static/reload', { method: 'POST' });
      fetchStatus();
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        await fetchStatus();
        const res = await fetch('/admin/status');
        const data = await res.json();
        if (!data.gtfsStatic.loading) { clearInterval(pollInterval); pollInterval = null; }
      }, 2000);
    }

    async function startRt() {
      await fetch('/admin/gtfs-rt/start', { method: 'POST' });
      fetchStatus();
      if (!pollInterval) pollInterval = setInterval(fetchStatus, 5000);
    }
    async function stopRt() {
      await fetch('/admin/gtfs-rt/stop', { method: 'POST' });
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      fetchStatus();
    }

    fetchStatus();
    setInterval(fetchStatus, 10000);

    // ── Patronage & Dwell ─────────────────────────────────────────────────

    let patronagePollInterval = null;

    async function loadPatronage() {
      document.getElementById('btn-load-patronage').disabled = true;
      document.getElementById('patronage-log').textContent = 'Starting…';
      await fetch('/admin/patronage/load', { method: 'POST' });
      patronagePollInterval = setInterval(pollPatronageStatus, 1500);
    }

    async function pollPatronageStatus() {
      const res = await fetch('/admin/patronage/status');
      const data = await res.json();
      document.getElementById('patronage-log').textContent = (data.log ?? []).join('\\n');
      if (!data.loading) {
        clearInterval(patronagePollInterval);
        patronagePollInterval = null;
        document.getElementById('btn-load-patronage').disabled = false;
        if (data.lastError) {
          document.getElementById('patronage-log').textContent += '\\nERROR: ' + data.lastError;
        }
        loadDwellTable();
        fetchPatronageMeta();
      }
    }

    async function fetchPatronageMeta() {
      const res = await fetch('/admin/patronage/dwell');
      const data = await res.json();
      const m = data.patronageMeta ?? {};
      document.getElementById('patronage-meta').textContent =
        m.matched ? \`\${m.matched} stops matched · Data year: \${m.year ?? '—'} · Loaded: \${m.loaded_at ? new Date(m.loaded_at).toLocaleString() : '—'}\`
                  : 'No patronage data loaded yet. Click "Load / Refresh Patronage" to fetch from PTV open data.';

      // Populate line selector
      const sel = document.getElementById('dwell-line-select');
      if (sel.options.length <= 1) {
        const linesRes = await fetch('/api/lines');
        const linesData = await linesRes.json();
        (linesData.lines ?? []).forEach(l => {
          const opt = document.createElement('option');
          opt.value = l.lineId;
          opt.textContent = l.name;
          sel.appendChild(opt);
        });
      }
    }

    async function loadDwellTable() {
      const lineId = document.getElementById('dwell-line-select').value;
      const url = '/admin/patronage/dwell' + (lineId ? \`?line=\${lineId}\` : '');
      const res = await fetch(url);
      const { rows, patronageMeta: m } = await res.json();

      document.getElementById('patronage-meta').textContent =
        m?.matched ? \`\${m.matched} stops matched · Data year: \${m.year ?? '—'} · Loaded: \${m.loaded_at ? new Date(m.loaded_at).toLocaleString() : '—'}\`
                   : 'No patronage data loaded yet.';

      if (!rows || rows.length === 0) {
        document.getElementById('dwell-table-wrap').innerHTML = '<p class="empty-note">No dwell stats computed yet.</p>';
        return;
      }

      const hasLine = !!lineId;
      const headerCols = hasLine
        ? ['Stop', 'Lines', 'Per-line pax/yr', 'Busyness', 'Base dwell', 'Peak dwell', 'Off-peak dwell', 'Peak gap', 'Off-peak gap']
        : ['Stop', 'Line', 'Busyness', 'Base dwell', 'Peak dwell'];

      const thead = \`<tr>\${headerCols.map(c => \`<th>\${c}</th>\`).join('')}</tr>\`;
      const tbody = rows.map(r => {
        const busy = (r.busyness_score * 100).toFixed(0) + '%';
        const bar = \`<div style="display:inline-block;width:\${Math.round(r.busyness_score*60)}px;height:4px;background:#3b82f6;border-radius:2px;vertical-align:middle;margin-left:4px"></div>\`;
        if (hasLine) {
          return \`<tr>
            <td style="color:#ccc">\${r.stop_name.replace(/ Station$/, '')}</td>
            <td style="color:#666">\${r.lines_at_stop}</td>
            <td style="color:#aaa">\${r.per_line_pax_annual != null ? r.per_line_pax_annual.toLocaleString() : '—'}</td>
            <td>\${busy}\${bar}</td>
            <td style="color:#4ade80">\${r.base_dwell_sec?.toFixed(0) ?? '—'}s</td>
            <td style="color:#fb923c">\${r.peak_dwell_sec?.toFixed(0) ?? '—'}s</td>
            <td style="color:#94a3b8">\${r.offpeak_dwell_sec?.toFixed(0) ?? '—'}s</td>
            <td style="color:#555">\${r.peak_gap_sec != null ? r.peak_gap_sec.toFixed(0)+'s' : '—'}</td>
            <td style="color:#555">\${r.offpeak_gap_sec != null ? r.offpeak_gap_sec.toFixed(0)+'s' : '—'}</td>
          </tr>\`;
        } else {
          return \`<tr>
            <td style="color:#ccc">\${r.stop_name.replace(/ Station$/, '')}</td>
            <td style="color:#666">\${r.line_id}</td>
            <td>\${busy}\${bar}</td>
            <td style="color:#4ade80">\${r.base_dwell_sec?.toFixed(0) ?? '—'}s</td>
            <td style="color:#fb923c">\${r.peak_dwell_sec?.toFixed(0) ?? '—'}s</td>
          </tr>\`;
        }
      }).join('');

      document.getElementById('dwell-table-wrap').innerHTML =
        \`<table class="veh-table"><thead>\${thead}</thead><tbody>\${tbody}</tbody></table>\`;
    }

    fetchPatronageMeta();

    // ── Data Management ──────────────────────────────────────────────────────

    let shapesPollInterval = null;

    async function fetchDataFreshness() {
      try {
        const res = await fetch('/admin/data-freshness');
        const data = await res.json();
        renderFreshnessTable(data.entities ?? [], data.lineShapeCount ?? 0);
      } catch { /* table not yet created */ }
    }

    function renderFreshnessTable(entities, lineShapeCount) {
      if (entities.length === 0) {
        document.getElementById('data-freshness-table').innerHTML =
          '<p class="empty-note">data_freshness table not found — run migration 003.</p>';
        return;
      }

      const FREQ_ORDER = ['manual','startup','daily','weekly','monthly'];
      const rows = entities.map(e => {
        const lastStr = e.lastLoadedAt
          ? new Date(e.lastLoadedAt).toLocaleString()
          : '<span style="color:#555">Never</span>';

        const now = Date.now();
        const lastMs = e.lastLoadedAt ? new Date(e.lastLoadedAt).getTime() : 0;
        const thresholds = { daily: 86400000, weekly: 604800000, monthly: 2592000000 };
        const threshold = thresholds[e.refreshFrequency];
        const stale = e.refreshFrequency === 'manual' ? false
          : e.refreshFrequency === 'startup' ? true
          : !e.lastLoadedAt ? true
          : threshold ? (now - lastMs) > threshold : false;
        const statusBadge = stale
          ? '<span class="badge badge-red">STALE</span>'
          : '<span class="badge badge-green">FRESH</span>';

        const extraInfo = e.entity === 'line_shapes'
          ? \`<span style="color:#555;font-size:0.78rem;margin-left:0.5rem">\${lineShapeCount} shapes in DB</span>\`
          : '';

        const loadBtn = e.entity === 'line_shapes'
          ? \`<button class="btn btn-blue btn-sm" onclick="loadShapes()">Load / Refresh</button>\`
          : e.entity === 'patronage'
          ? \`<button class="btn btn-blue btn-sm" onclick="loadPatronage()">Load / Refresh</button>\`
          : e.entity === 'gtfs_static'
          ? \`<button class="btn btn-blue btn-sm" onclick="reloadStatic()">Load / Reload</button>\`
          : '';

        return \`<tr>
          <td style="color:#ccc;font-weight:500">\${e.label}</td>
          <td style="color:#666;font-size:0.8rem">\${e.description ?? ''}</td>
          <td>\${statusBadge}</td>
          <td style="color:#777;font-size:0.8rem">\${e.refreshFrequency}</td>
          <td style="color:#aaa;font-size:0.8rem">\${lastStr}\${extraInfo}</td>
          <td>\${loadBtn}</td>
        </tr>\`;
      });

      document.getElementById('data-freshness-table').innerHTML = \`
        <table class="veh-table">
          <thead><tr>
            <th>Dataset</th><th>Description</th><th>Status</th>
            <th>Auto-refresh</th><th>Last loaded</th><th></th>
          </tr></thead>
          <tbody>\${rows.join('')}</tbody>
        </table>\`;
    }

    async function loadShapes() {
      document.getElementById('shapes-log').textContent = 'Starting shape load…';
      await fetch('/admin/shapes/load', { method: 'POST' });
      shapesPollInterval = setInterval(pollShapesStatus, 1500);
    }

    async function pollShapesStatus() {
      const res = await fetch('/admin/shapes/status');
      const data = await res.json();
      document.getElementById('shapes-log').textContent = (data.log ?? []).join('\\n');
      if (!data.loading) {
        clearInterval(shapesPollInterval);
        shapesPollInterval = null;
        if (data.lastError) {
          document.getElementById('shapes-log').textContent += '\\nERROR: ' + data.lastError;
        }
        fetchDataFreshness();
      }
    }

    fetchDataFreshness();
    setInterval(fetchDataFreshness, 30000);

    // ── Replay ───────────────────────────────────────────────────────────────

    let replayPollInterval = null;

    async function loadReplaySessions() {
      const res = await fetch('/admin/replay/sessions');
      const { sessions } = await res.json();
      const sel = document.getElementById('replay-session-select');
      sel.innerHTML = '<option value="">— Select capture session —</option>';
      sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
      });
    }

    async function startReplay() {
      const session = document.getElementById('replay-session-select').value;
      if (!session) return;
      const speed = parseFloat(document.getElementById('replay-speed-select').value);
      document.getElementById('btn-replay-start').disabled = true;
      const res = await fetch('/admin/replay/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, speed }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert('Replay error: ' + (err.error ?? 'unknown'));
        document.getElementById('btn-replay-start').disabled = false;
        return;
      }
      document.getElementById('btn-replay-stop').disabled = false;
      if (!replayPollInterval) replayPollInterval = setInterval(pollReplayStatus, 1000);
    }

    async function stopReplay() {
      await fetch('/admin/replay/stop', { method: 'POST' });
      if (replayPollInterval) { clearInterval(replayPollInterval); replayPollInterval = null; }
      renderReplayStatus({ active: false, session: null, snapshotIndex: 0, totalSnapshots: 0, speed: 1 });
    }

    async function pollReplayStatus() {
      const res = await fetch('/admin/replay/status');
      const data = await res.json();
      renderReplayStatus(data);
      if (!data.active) {
        clearInterval(replayPollInterval);
        replayPollInterval = null;
      }
    }

    function renderReplayStatus(s) {
      const active = s.active;
      document.getElementById('btn-replay-start').disabled = active;
      document.getElementById('btn-replay-stop').disabled = !active;
      document.getElementById('replay-progress-wrap').style.display = active ? '' : 'none';

      if (active) {
        const pct = s.totalSnapshots > 0 ? Math.round((s.snapshotIndex / s.totalSnapshots) * 100) : 0;
        document.getElementById('replay-progress-bar').style.width = pct + '%';
        const capAt = s.capturedAt ? ' · captured ' + new Date(s.capturedAt).toLocaleTimeString() : '';
        document.getElementById('replay-status').textContent =
          \`Replaying \${s.session} — snapshot \${s.snapshotIndex + 1} / \${s.totalSnapshots} at \${s.speed}×\${capAt}\`;
      } else {
        document.getElementById('replay-status').textContent = active ? '' : 'No active replay.';
      }
    }

    loadReplaySessions();
    pollReplayStatus();
  </script>
</body>
</html>`;
}
