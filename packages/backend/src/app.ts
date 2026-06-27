import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { config } from './config.js';
import { redis, redisSub } from './redis/client.js';
import { pool } from './db/client.js';
import { setupSocket } from './socket/index.js';
import { healthRoutes } from './routes/health.js';
import { linesRoutes } from './routes/lines.js';
import { tripsRoutes } from './routes/trips.js';
import { adminRoutes } from './routes/admin.js';
import { startPoller, stopPoller } from './gtfs-rt/poller.js';
import { setRouteLineMap, setLineStopCoords, setGlobalStopNames, setTripDirections } from './gtfs-rt/publisher.js';
import { getLines } from './db/queries/lines.js';

async function loadRouteLineMap(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ route_id: string; line_id: string }>(
    `SELECT route_id, line_id FROM routes WHERE line_id IS NOT NULL AND route_type = 400`
  );
  const map = new Map(rows.map(r => [r.route_id, r.line_id]));
  console.log(`[app] Loaded ${map.size} route→line mappings`);
  return map;
}

async function loadLineStopCoordsFromLines(): Promise<void> {
  const lines = await getLines();
  const map = new Map(lines.map(line => [
    line.lineId,
    line.stops.map(s => ({ stopId: s.stopId, stopName: s.stopName, canonicalX: s.canonicalX, lat: s.stopLat, lon: s.stopLon })),
  ]));
  setLineStopCoords(map);
  console.log(`[app] Loaded stop coords for ${map.size} lines`);
}

async function loadGlobalStopNames(): Promise<void> {
  const { rows } = await pool.query<{ stop_id: string; stop_name: string }>(
    `SELECT stop_id, stop_name FROM stops`
  );
  setGlobalStopNames(new Map(rows.map(r => [r.stop_id, r.stop_name])));
  console.log(`[app] Loaded ${rows.length} global stop names for TU fallback lookup`);
}

async function loadTripDirections(): Promise<void> {
  const { rows } = await pool.query<{ trip_id: string; direction_id: number }>(
    `SELECT trip_id, direction_id FROM trips WHERE direction_id IS NOT NULL`
  );
  setTripDirections(new Map(rows.map(r => [r.trip_id, r.direction_id])));
}

export async function buildApp() {
  const fastify = Fastify({ logger: true, pluginTimeout: 30_000 });

  await fastify.register(cors, { origin: config.CORS_ORIGIN });

  const io = new Server(fastify.server, {
    cors: { origin: config.CORS_ORIGIN },
  });

  setupSocket(io);

  await fastify.register(healthRoutes);
  await fastify.register(linesRoutes);
  await fastify.register(tripsRoutes);
  await fastify.register(adminRoutes, { io });

  fastify.addHook('onReady', async () => {
    try {
      const [routeMap] = await Promise.all([
        loadRouteLineMap(),
        loadLineStopCoordsFromLines(),
        loadGlobalStopNames(),
        loadTripDirections(),
      ]);
      setRouteLineMap(routeMap);
    } catch (err) {
      // Routes/stops tables may be empty before first GTFS load — not fatal
      console.warn('[app] Could not load GTFS maps (data not loaded yet?):', err);
    }
    if (config.GTFS_RT_ENABLED) startPoller(io);
  });

  fastify.addHook('onClose', async () => {
    stopPoller();
    io.close();
    await redis.quit();
    await redisSub.quit();
    await pool.end();
  });

  return { fastify, io };
}
