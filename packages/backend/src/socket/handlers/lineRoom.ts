import type { Socket } from 'socket.io';
import type { LivePosition } from '@takemethere/shared';
import { redis } from '../../redis/client.js';

export function registerLineRoomHandlers(socket: Socket): void {
  socket.on('rooms:join', async ({ lines }: { lines: string[] }) => {
    for (const lineId of lines) {
      socket.join(`line:${lineId}`);
    }

    // Immediately send current state from Redis so the UI doesn't wait for the next poll
    try {
      const redisKeys = await redis.keys('vehicle:*');
      if (redisKeys.length === 0) return;
      const raw = await redis.mget(...redisKeys);
      const vehicles = raw
        .filter((v): v is string => v !== null)
        .map(v => JSON.parse(v) as LivePosition)
        .filter(v => lines.includes(v.lineId));
      if (vehicles.length > 0) {
        socket.emit('vehicles:update', vehicles);
      }
    } catch (err) {
      // Non-fatal: client will get data on the next poll
      console.error('[lineRoom] Failed to send initial state:', err);
    }
  });

  socket.on('rooms:leave', ({ lines }: { lines: string[] }) => {
    for (const lineId of lines) {
      socket.leave(`line:${lineId}`);
    }
  });
}
