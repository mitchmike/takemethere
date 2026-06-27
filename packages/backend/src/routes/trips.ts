import type { FastifyInstance } from 'fastify';
import { getStopTimesForTrip } from '../db/queries/stopTimes.js';

export async function tripsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { tripId: string } }>(
    '/api/trips/:tripId/stop-times',
    async (req, reply) => {
      const stopTimes = await getStopTimesForTrip(req.params.tripId);
      return reply.send({ stopTimes });
    },
  );
}
