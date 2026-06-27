import type { FastifyInstance } from 'fastify';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { pool } from '../db/client.js';
import { redis } from '../redis/client.js';
import { startPoller, stopPoller, getPollerStatus } from '../gtfs-rt/poller.js';
import { setRouteLineMap, setLineStopCoords, setGlobalStopNames, getPrevNextStopNames } from '../gtfs-rt/publisher.js';
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
      // Refresh route→line map so RT poller picks up new data immediately
      reloadMaps().catch(err => console.error('[admin] Failed to reload maps:', err));
    }
    if (msg.error) {
      loadState.loading = false;
      loadState.lastError = msg.error;
      loadState.currentStep = null;
    }
  });

  worker.on('error', err => {
    loadState.loading = false;
    loadState.lastError = err.message;
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
    return reply.send({ ok: true, status: getPollerStatus() });
  });

  fastify.post('/admin/gtfs-rt/stop', async (_req, reply) => {
    stopPoller();
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

        // Estimated position between prev and next stop
        let estimatedPct: number | null = null;
        if (pos.nextArrivalEpoch > 0 && pos.nextStopCanonicalX >= 0 && pos.nextStopCanonicalX !== pos.canonicalX) {
          const elapsed = nowEpoch - pos.timestamp;
          const total = pos.nextArrivalEpoch - pos.timestamp;
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
      <button class="btn btn-red"   id="btn-stop"  onclick="stopRt()">Stop Poller</button>
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
  </script>
</body>
</html>`;
}
