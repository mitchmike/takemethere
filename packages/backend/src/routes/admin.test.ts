import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

let fastify: FastifyInstance;

beforeAll(async () => {
  ({ fastify } = await buildApp());
  await fastify.ready();
});

afterAll(async () => {
  await fastify.close();
});

// ─── GET /admin/status ────────────────────────────────────────────────────────

describe('GET /admin/status', () => {
  it('returns 200', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/status' });
    expect(res.statusCode).toBe(200);
  });

  it('has gtfsStatic, gtfsRt, socket sections', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/status' });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('gtfsStatic');
    expect(body).toHaveProperty('gtfsRt');
    expect(body).toHaveProperty('socket');
  });

  it('gtfsRt.running reflects GTFS_RT_ENABLED env var', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/status' });
    const body = JSON.parse(res.body);
    // GTFS_RT_ENABLED=true in .env — poller auto-starts on app ready
    const expected = process.env.GTFS_RT_ENABLED === 'true';
    expect(body.gtfsRt.running).toBe(expected);
  });

  it('gtfsStatic.counts has all expected tables', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/status' });
    const body = JSON.parse(res.body);
    const tables = body.gtfsStatic.counts.map((c: { table: string }) => c.table);
    expect(tables).toContain('routes');
    expect(tables).toContain('stops');
    expect(tables).toContain('trips');
    expect(tables).toContain('stop_times');
    expect(tables).toContain('line_station_order');
  });
});

// ─── GET /admin/data-freshness ────────────────────────────────────────────────

describe('GET /admin/data-freshness', () => {
  it('returns 200', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/data-freshness' });
    expect(res.statusCode).toBe(200);
  });

  it('returns entities array with all expected entries', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/data-freshness' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.entities)).toBe(true);
    const names = body.entities.map((e: { entity: string }) => e.entity);
    expect(names).toContain('gtfs_static');
    expect(names).toContain('line_shapes');
    expect(names).toContain('patronage');
  });

  it('each entity has required fields', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/data-freshness' });
    const body = JSON.parse(res.body);
    for (const e of body.entities) {
      expect(e).toHaveProperty('entity');
      expect(e).toHaveProperty('refreshFrequency');
      expect(e).toHaveProperty('label');
    }
  });

  it('has lineShapeCount', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/data-freshness' });
    const body = JSON.parse(res.body);
    expect(typeof body.lineShapeCount).toBe('number');
  });
});

// ─── GET /admin ───────────────────────────────────────────────────────────────

describe('GET /admin', () => {
  it('returns 200 text/html', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('HTML contains required section IDs', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin' });
    const html = res.body;
    for (const id of ['static-counts', 'rt-core', 'data-freshness-table', 'patronage-card']) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('Stop Poller button is initially disabled', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin' });
    // btn-stop must carry the disabled attribute in HTML so the button is
    // visually correct before the first fetchStatus() call completes.
    expect(res.body).toContain('id="btn-stop"');
    const btnStopIdx = res.body.indexOf('id="btn-stop"');
    const buttonTag = res.body.substring(res.body.lastIndexOf('<button', btnStopIdx), btnStopIdx + 80);
    expect(buttonTag).toContain('disabled');
  });

  it('embedded JavaScript has no syntax errors', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin' });
    const html = res.body;

    const scriptStart = html.indexOf('<script>');
    const scriptEnd = html.indexOf('</script>');
    expect(scriptStart).toBeGreaterThan(-1);
    expect(scriptEnd).toBeGreaterThan(scriptStart);

    const script = html.substring(scriptStart + 8, scriptEnd);

    // new Function() will throw SyntaxError if the JS is invalid
    expect(() => new Function(script)).not.toThrow();
  });
});

// ─── GET /api/lines response shape (used by admin page) ──────────────────────

describe('GET /api/lines response shape', () => {
  it('returns { lines: [...] } not a bare array', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const body = JSON.parse(res.body);
    // Admin page calls (linesData.lines ?? []).forEach — must be a property, not root array
    expect(body).toHaveProperty('lines');
    expect(Array.isArray(body.lines)).toBe(true);
    expect(Array.isArray(body)).toBe(false);
  });
});

// ─── GET /admin/patronage/status ──────────────────────────────────────────────

describe('GET /admin/patronage/status', () => {
  it('returns 200 with loading:false initially', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/patronage/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.loading).toBe(false);
  });
});

// ─── GET /admin/shapes/status ─────────────────────────────────────────────────

describe('GET /admin/shapes/status', () => {
  it('returns 200 with loading:false initially', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/shapes/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.loading).toBe(false);
  });
});

// ─── POST /admin/gtfs-rt/start + stop ─────────────────────────────────────────

describe('POST /admin/gtfs-rt/start', () => {
  afterAll(async () => {
    // Restore poller to its original state based on env config
    if (process.env.GTFS_RT_ENABLED !== 'true') {
      await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    }
  });

  it('returns 200', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/start' });
    expect(res.statusCode).toBe(200);
  });

  it('returns ok:true', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/start' });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('after start, GET /admin/status shows gtfsRt.running=true', async () => {
    await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/start' });
    const res = await fastify.inject({ method: 'GET', url: '/admin/status' });
    const body = JSON.parse(res.body);
    expect(body.gtfsRt.running).toBe(true);
  });
});

describe('POST /admin/gtfs-rt/stop', () => {
  it('returns 200', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    expect(res.statusCode).toBe(200);
  });

  it('returns ok:true', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('after stop, GET /admin/status shows gtfsRt.running=false', async () => {
    await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    const res = await fastify.inject({ method: 'GET', url: '/admin/status' });
    const body = JSON.parse(res.body);
    expect(body.gtfsRt.running).toBe(false);
  });

  it('calling stop twice is idempotent — returns 200 both times', async () => {
    const r1 = await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    const r2 = await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });
});

describe('POST /admin/gtfs-rt/start → stop → start cycle', () => {
  afterAll(async () => {
    // Leave poller stopped so tests don't leave background processes
    await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
  });

  it('start then stop then start reflects correct running state each time', async () => {
    await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/start' });
    const s1 = JSON.parse((await fastify.inject({ method: 'GET', url: '/admin/status' })).body);
    expect(s1.gtfsRt.running).toBe(true);

    await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/stop' });
    const s2 = JSON.parse((await fastify.inject({ method: 'GET', url: '/admin/status' })).body);
    expect(s2.gtfsRt.running).toBe(false);

    await fastify.inject({ method: 'POST', url: '/admin/gtfs-rt/start' });
    const s3 = JSON.parse((await fastify.inject({ method: 'GET', url: '/admin/status' })).body);
    expect(s3.gtfsRt.running).toBe(true);
  });
});

// ─── GET /admin/rt/vehicles ────────────────────────────────────────────────────

describe('GET /admin/rt/vehicles', () => {
  it('returns 200', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/rt/vehicles' });
    expect(res.statusCode).toBe(200);
  });

  it('returns a vehicles array', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/rt/vehicles' });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('vehicles');
    expect(Array.isArray(body.vehicles)).toBe(true);
  });

  it('each vehicle has required LivePosition fields', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/admin/rt/vehicles' });
    const { vehicles } = JSON.parse(res.body);
    if (vehicles.length === 0) return; // no live data available in test env — skip shape check

    const v = vehicles[0];
    expect(typeof v.tripId).toBe('string');
    expect(typeof v.lineId).toBe('string');
    expect(typeof v.lat).toBe('number');
    expect(typeof v.lon).toBe('number');
    expect(typeof v.canonicalX).toBe('number');
    expect(typeof v.directionId).toBe('number');
  });
});
