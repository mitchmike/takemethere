import type { Server } from 'socket.io';
import type { VehiclePosition } from '@takemethere/shared';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';

// In-memory map of routeId → lineId, populated at startup
let routeLineMap: Map<string, string> = new Map();

export function setRouteLineMap(map: Map<string, string>): void {
  routeLineMap = map;
}

export async function publishPositions(
  io: Server,
  positions: VehiclePosition[],
): Promise<void> {
  const byLine = new Map<string, VehiclePosition[]>();

  for (const pos of positions) {
    if (!pos.tripId) continue;

    // Cache individual vehicle
    await redis.set(keys.vehicle(pos.tripId), JSON.stringify(pos), 'EX', 120);

    const lineId = pos.routeId ? routeLineMap.get(pos.routeId) : undefined;
    if (!lineId) continue;

    if (!byLine.has(lineId)) byLine.set(lineId, []);
    byLine.get(lineId)!.push(pos);
  }

  for (const [lineId, linePositions] of byLine) {
    const room = `line:${lineId}`;
    // Skip emit if no subscribers
    if (io.sockets.adapter.rooms.get(room)?.size) {
      io.to(room).emit('vehicles:update', linePositions);
    }
  }

  // Emit all to 'line:all' room
  if (io.sockets.adapter.rooms.get('line:all')?.size) {
    io.to('line:all').emit('vehicles:update', positions);
  }
}
