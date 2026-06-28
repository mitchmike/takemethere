/**
 * Simulator capture routes — record live vehicle snapshots for later replay.
 *
 * POST /admin/sim/capture?session=<name>
 *   Appends a snapshot of current vehicle positions to data/sim-captures/<name>.jsonl.
 *   Creates the file on first call. Session name must be alphanumeric/dash/dot.
 *
 * GET /admin/sim/sessions
 *   Lists available session files with snapshot counts and time ranges.
 *
 * DELETE /admin/sim/session/:name
 *   Deletes a session file.
 */

import type { FastifyInstance } from 'fastify';
import { appendFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redis } from '../redis/client.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, '../../data/sim-captures');

// Restrict session names to safe characters
const SESSION_NAME_RE = /^[\w.\-]{1,64}$/;

function sessionPath(name: string): string {
  const safe = name.endsWith('.jsonl') ? name : `${name}.jsonl`;
  return join(DATA_DIR, safe);
}

/** Fetch all vehicle positions from Redis (mirrors admin/rt/vehicles logic). */
async function fetchVehicles(): Promise<object[]> {
  const vehicleKeys = await redis.keys('vehicle:*');
  if (!vehicleKeys.length) return [];
  const raw = await redis.mget(...vehicleKeys);
  return raw
    .filter((v): v is string => v !== null)
    .map(v => JSON.parse(v));
}

export async function simRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /admin/sim/capture?session=<name>
  fastify.post<{ Querystring: { session?: string } }>('/admin/sim/capture', async (req, reply) => {
    const name = (req.query.session ?? '').trim();
    if (!name || !SESSION_NAME_RE.test(name)) {
      return reply.code(400).send({ error: 'Provide ?session=<name> (alphanumeric, dash, dot; max 64 chars)' });
    }

    const vehicles = await fetchVehicles();
    const snapshot = JSON.stringify({ capturedAt: new Date().toISOString(), vehicles });

    try {
      appendFileSync(sessionPath(name), snapshot + '\n', 'utf8');
    } catch (err) {
      fastify.log.error(err, 'sim capture write failed');
      return reply.code(500).send({ error: 'Write failed' });
    }

    return reply.send({ ok: true, session: name, vehicleCount: vehicles.length, capturedAt: new Date().toISOString() });
  });

  // GET /admin/sim/sessions
  fastify.get('/admin/sim/sessions', async (_req, reply) => {
    let files: string[];
    try {
      files = readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl')).sort();
    } catch {
      return reply.send({ sessions: [] });
    }

    const sessions = files.map(f => {
      const path = join(DATA_DIR, f);
      let snapshotCount = 0;
      let firstCapturedAt: string | null = null;
      let lastCapturedAt: string | null = null;
      let vehicleCount: number | null = null;

      try {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        snapshotCount = lines.length;
        if (lines.length > 0) {
          const first = JSON.parse(lines[0]);
          firstCapturedAt = first.capturedAt ?? null;
          vehicleCount = first.vehicles?.length ?? null;
        }
        if (lines.length > 1) {
          lastCapturedAt = JSON.parse(lines[lines.length - 1]).capturedAt ?? null;
        }
      } catch { /* skip malformed */ }

      return {
        name: f.replace(/\.jsonl$/, ''),
        file: f,
        sizeBytes: statSync(path).size,
        snapshotCount,
        vehicleCount,
        firstCapturedAt,
        lastCapturedAt,
      };
    });

    return reply.send({ sessions });
  });

  // DELETE /admin/sim/session/:name
  fastify.delete<{ Params: { name: string } }>('/admin/sim/session/:name', async (req, reply) => {
    const { name } = req.params;
    if (!SESSION_NAME_RE.test(name)) {
      return reply.code(400).send({ error: 'Invalid session name' });
    }
    try {
      unlinkSync(sessionPath(name));
      return reply.send({ ok: true });
    } catch {
      return reply.code(404).send({ error: 'Session not found' });
    }
  });
}
