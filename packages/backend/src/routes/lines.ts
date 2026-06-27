import type { FastifyInstance } from 'fastify';
import { getLines } from '../db/queries/lines.js';

export async function linesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/lines', async (_req, reply) => {
    const lines = await getLines();
    return reply.send({ lines });
  });
}
