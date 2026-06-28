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

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });
});

describe('GET /api/lines', () => {
  it('returns 200', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    expect(res.statusCode).toBe(200);
  });

  it('returns an array of line definitions', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const body = JSON.parse(res.body).lines;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('each line has required fields', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const lines = JSON.parse(res.body).lines;
    for (const line of lines) {
      expect(typeof line.lineId).toBe('string');
      expect(typeof line.name).toBe('string');
      expect(typeof line.color).toBe('string');
      expect(Array.isArray(line.stops)).toBe(true);
    }
  });

  it('each stop has a canonicalX in [0, 1]', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const lines = JSON.parse(res.body).lines;
    for (const line of lines) {
      for (const stop of line.stops) {
        expect(stop.canonicalX).toBeGreaterThanOrEqual(0);
        expect(stop.canonicalX).toBeLessThanOrEqual(1);
      }
    }
  });

  it('belgrave line is present and has ordered stops including Richmond', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const lines = JSON.parse(res.body).lines;
    const belgrave = lines.find((l: any) => l.lineId === 'belgrave');
    expect(belgrave).toBeDefined();
    const stopNames = belgrave.stops.map((s: any) => s.stopName as string);
    expect(stopNames.some(n => n.includes('Richmond'))).toBe(true);
    expect(stopNames.some(n => n.includes('Belgrave'))).toBe(true);
  });

  it('belgrave stop canonicalX values are monotonically non-decreasing', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/lines' });
    const lines = JSON.parse(res.body).lines;
    const belgrave = lines.find((l: any) => l.lineId === 'belgrave');
    expect(belgrave).toBeDefined();
    for (let i = 1; i < belgrave.stops.length; i++) {
      expect(belgrave.stops[i].canonicalX).toBeGreaterThanOrEqual(belgrave.stops[i - 1].canonicalX);
    }
  });
});
