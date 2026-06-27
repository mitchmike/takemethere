import type { FastifyInstance } from 'fastify';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { pool } from '../db/client.js';
import { startPoller, stopPoller, getPollerStatus } from '../gtfs-rt/poller.js';
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

function spawnLoaderWorker(): void {
  loadState.steps = [];
  loadState.currentStep = 'downloading';

  const worker = new Worker(workerPath, { execArgv: ['--import', 'tsx/esm'] });

  worker.on('message', (msg: { progress?: string; count?: number; done?: boolean; error?: string }) => {
    if (msg.progress) {
      // Mark previous step done
      const prev = loadState.steps.find(s => s.step === loadState.currentStep);
      if (prev) prev.done = true;

      if (msg.count !== undefined) {
        // This progress message completes a step with a count
        const existing = loadState.steps.find(s => s.step === msg.progress);
        if (existing) { existing.count = msg.count; existing.done = true; }
        else loadState.steps.push({ step: msg.progress!, count: msg.count, done: true });
        loadState.currentStep = null;
      } else {
        // Starting a new step
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

export async function adminRoutes(fastify: FastifyInstance, { io }: { io: Server }): Promise<void> {
  fastify.get('/admin/status', async (_req, reply) => {
    const [tableCounts, rt] = await Promise.all([getTableCounts(), getPollerStatus()]);
    return reply.send({
      gtfsStatic: { ...loadState, counts: tableCounts },
      gtfsRt: rt,
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

  fastify.post('/admin/gtfs-static/reload', async (_req, reply) => {
    if (loadState.loading) return reply.code(409).send({ error: 'Load already in progress' });
    loadState.loading = true;
    loadState.lastError = null;
    reply.send({ ok: true, message: 'Load started' });
    spawnLoaderWorker();
  });

  // Serve the admin UI
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
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 2rem; color: #fff; }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #ccc; text-transform: uppercase; letter-spacing: 0.05em; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; max-width: 960px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.5rem; }
    .stat-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #222; font-size: 0.875rem; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #888; }
    .stat-value { font-variant-numeric: tabular-nums; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-green { background: #14532d; color: #4ade80; }
    .badge-red { background: #450a0a; color: #f87171; }
    .badge-yellow { background: #422006; color: #fb923c; }
    .btn { display: inline-block; padding: 0.5rem 1.2rem; border-radius: 6px; border: none; cursor: pointer; font-size: 0.875rem; font-weight: 500; margin-top: 1rem; margin-right: 0.5rem; }
    .btn-green { background: #166534; color: #fff; } .btn-green:hover { background: #15803d; }
    .btn-red { background: #7f1d1d; color: #fff; } .btn-red:hover { background: #991b1b; }
    .btn-blue { background: #1e3a5f; color: #fff; } .btn-blue:hover { background: #1d4ed8; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .error { color: #f87171; font-size: 0.8rem; margin-top: 0.75rem; word-break: break-all; }
    .meta { color: #666; font-size: 0.8rem; margin-top: 0.75rem; }
    #refresh-time { color: #555; font-size: 0.8rem; margin-bottom: 1.5rem; }
    .steps { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.35rem; }
    .step { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
    .step-icon { width: 1.1rem; text-align: center; flex-shrink: 0; }
    .step-label { color: #aaa; }
    .step-label.active { color: #fff; }
    .step-label.done { color: #666; }
    .step-count { margin-left: auto; color: #555; font-variant-numeric: tabular-nums; font-size: 0.8rem; }
    .spinner { display: inline-block; width: 0.75rem; height: 0.75rem; border: 2px solid #555; border-top-color: #fb923c; border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .progress-bar-wrap { margin-top: 0.75rem; height: 4px; background: #2a2a2a; border-radius: 2px; overflow: hidden; }
    .progress-bar { height: 100%; background: #1d4ed8; border-radius: 2px; transition: width 0.5s ease; }
  </style>
</head>
<body>
  <h1>TakeMeThere — Admin</h1>
  <p id="refresh-time">Loading...</p>
  <div class="grid">
    <div class="card">
      <h2>GTFS Static</h2>
      <div id="static-steps"></div>
      <div id="static-counts"></div>
      <div id="static-error" class="error"></div>
      <button class="btn btn-blue" id="btn-reload" onclick="reloadStatic()">Load / Reload Data</button>
    </div>
    <div class="card">
      <h2>GTFS-RT (Live Feed)</h2>
      <div id="rt-status"></div>
      <div id="rt-meta"></div>
      <div id="rt-error" class="error"></div>
      <button class="btn btn-green" id="btn-start" onclick="startRt()">Start Poller</button>
      <button class="btn btn-red" id="btn-stop" onclick="stopRt()">Stop Poller</button>
    </div>
  </div>

  <script>
    const STEP_LABELS = ${stepLabels};
    const STEP_ORDER = ['downloading','routes','stops','trips','stop_times','view'];

    async function fetchStatus() {
      const res = await fetch('/admin/status');
      const data = await res.json();
      renderStatic(data.gtfsStatic);
      renderRt(data.gtfsRt);
      document.getElementById('refresh-time').textContent = 'Last refreshed: ' + new Date().toLocaleTimeString();
    }

    function renderStatic(s) {
      const loading = s.loading;
      const steps = s.steps ?? [];
      const currentStep = s.currentStep;
      const hasData = (s.counts ?? []).find(c => c.table === 'stop_times')?.count > 0;

      // Steps panel — only shown while loading or just finished
      if (loading || steps.length > 0) {
        const stepsHtml = STEP_ORDER.map(key => {
          const found = steps.find(st => st.step === key);
          const isActive = key === currentStep;
          const isDone = found?.done;
          const icon = isDone ? '✓' : isActive ? '<span class="spinner"></span>' : '·';
          const labelClass = isDone ? 'done' : isActive ? 'active' : '';
          const count = found?.count != null ? found.count.toLocaleString() : '';
          return \`<div class="step">
            <span class="step-icon">\${icon}</span>
            <span class="step-label \${labelClass}">\${STEP_LABELS[key] ?? key}</span>
            \${count ? \`<span class="step-count">\${count}</span>\` : ''}
          </div>\`;
        }).join('');

        // Progress bar based on completed steps
        const completedSteps = steps.filter(st => st.done).length;
        const pct = Math.round((completedSteps / STEP_ORDER.length) * 100);

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

    function renderRt(rt) {
      const badge = rt.running ? '<span class="badge badge-green">Running</span>' : '<span class="badge badge-red">Stopped</span>';
      document.getElementById('rt-status').innerHTML =
        \`<div class="stat-row"><span class="stat-label">Status</span><span>\${badge}</span></div>
         <div class="stat-row"><span class="stat-label">Vehicles</span><span class="stat-value">\${rt.vehicleCount}</span></div>\`;
      const meta = rt.lastPollAt ? 'Last poll: ' + new Date(rt.lastPollAt).toLocaleString() : 'Not polled yet';
      document.getElementById('rt-meta').innerHTML = \`<p class="meta">\${meta}</p>\`;
      document.getElementById('rt-error').textContent = rt.lastError ?? '';
      document.getElementById('btn-start').disabled = rt.running;
      document.getElementById('btn-stop').disabled = !rt.running;
    }

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

    async function startRt() { await fetch('/admin/gtfs-rt/start', { method: 'POST' }); fetchStatus(); }
    async function stopRt() { await fetch('/admin/gtfs-rt/stop', { method: 'POST' }); fetchStatus(); }

    fetchStatus();
    setInterval(fetchStatus, 10000);
  </script>
</body>
</html>`;
}
