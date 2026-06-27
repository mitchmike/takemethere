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

export async function buildApp() {
  const fastify = Fastify({ logger: true });

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
