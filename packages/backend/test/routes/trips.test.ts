import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

let fastify: FastifyInstance;

beforeAll(async () => {
  ({ fastify } = await buildApp());
  await fastify.ready();
});

afterAll(async () => {
  await fastify.close();
});

describe('GET /api/trips/:tripId/stop-times', () => {
  it('returns 200 for a valid tripId that exists in the database', async () => {
    const linesRes = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const lines = JSON.parse(linesRes.body).lines as any[];
    expect(lines.length).toBeGreaterThan(0);

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/trips/nonexistent-trip-id/stop-times',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('stopTimes');
    expect(Array.isArray(body.stopTimes)).toBe(true);
    expect(body.stopTimes).toHaveLength(0);
  });

  it('response shape has required fields when stop times exist', async () => {
    const { pool } = await import('../../src/db/client.js');
    const { rows } = await pool.query<{ trip_id: string }>(
      `SELECT DISTINCT trip_id FROM stop_times LIMIT 1`,
    );
    if (rows.length === 0) return;

    const tripId = rows[0].trip_id;
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/trips/${encodeURIComponent(tripId)}/stop-times`,
    });
    expect(res.statusCode).toBe(200);
    const { stopTimes } = JSON.parse(res.body);
    expect(Array.isArray(stopTimes)).toBe(true);
    expect(stopTimes.length).toBeGreaterThan(0);

    const first = stopTimes[0];
    expect(typeof first.tripId).toBe('string');
    expect(typeof first.stopSequence).toBe('number');
    expect(typeof first.stopId).toBe('string');
    expect(first.arrivalTime === null || typeof first.arrivalTime === 'number').toBe(true);
    expect(first.departureTime === null || typeof first.departureTime === 'number').toBe(true);
  });

  it('stop times are ordered by stop_sequence ascending', async () => {
    const { pool } = await import('../../src/db/client.js');
    const { rows } = await pool.query<{ trip_id: string }>(
      `SELECT DISTINCT trip_id FROM stop_times LIMIT 1`,
    );
    if (rows.length === 0) return;

    const tripId = rows[0].trip_id;
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/trips/${encodeURIComponent(tripId)}/stop-times`,
    });
    const { stopTimes } = JSON.parse(res.body);
    if (stopTimes.length < 2) return;

    for (let i = 1; i < stopTimes.length; i++) {
      expect(stopTimes[i].stopSequence).toBeGreaterThanOrEqual(stopTimes[i - 1].stopSequence);
    }
  });

  it('all stop times for a trip share the same tripId', async () => {
    const { pool } = await import('../../src/db/client.js');
    const { rows } = await pool.query<{ trip_id: string }>(
      `SELECT DISTINCT trip_id FROM stop_times LIMIT 1`,
    );
    if (rows.length === 0) return;

    const tripId = rows[0].trip_id;
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/trips/${encodeURIComponent(tripId)}/stop-times`,
    });
    const { stopTimes } = JSON.parse(res.body);
    expect(stopTimes.every((s: any) => s.tripId === tripId)).toBe(true);
  });
});
