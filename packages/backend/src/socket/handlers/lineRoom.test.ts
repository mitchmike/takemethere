import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LivePosition } from '@takemethere/shared';

// Mock Redis before importing the handler so the module resolves our mock
vi.mock('../../redis/client.js', () => ({
  redis: {
    keys: vi.fn(),
    mget: vi.fn(),
  },
}));

import { registerLineRoomHandlers } from './lineRoom.js';
import { redis } from '../../redis/client.js';

function makeSocket() {
  const joinedRooms: string[] = [];
  const leftRooms: string[] = [];
  const emitted: { event: string; data: unknown }[] = [];
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  return {
    join: vi.fn((room: string) => { joinedRooms.push(room); }),
    leave: vi.fn((room: string) => { leftRooms.push(room); }),
    emit: vi.fn((event: string, data: unknown) => { emitted.push({ event, data }); }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    // Test helper: trigger a registered event and return a promise that resolves when all handlers complete
    trigger: (event: string, ...args: unknown[]) =>
      Promise.all((listeners[event] ?? []).map(h => h(...args))),
    _joinedRooms: joinedRooms,
    _leftRooms:   leftRooms,
    _emitted:     emitted,
  } as any;
}

function makeVehicle(tripId: string, lineId: string): LivePosition {
  return {
    tripId, lineId, lat: -37.85, lon: 145.1, bearing: 90,
    timestamp: 1_700_000_000, canonicalX: 0.3, delay: 0, directionId: 0,
    prevStopId: 'p1', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
    nextStopId: 'n1', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
    scheduledNextArrivalEpoch: 0, nextArrivalEpoch: 0, predictedNextArrivalEpoch: 0,
    segmentSpeedKmh: null, upcomingStops: [],
  };
}

const mockRedis = redis as { keys: ReturnType<typeof vi.fn>; mget: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerLineRoomHandlers', () => {
  describe('rooms:join', () => {
    it('joins a socket room for each lineId', async () => {
      mockRedis.keys.mockResolvedValue([]);
      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      await socket.trigger('rooms:join', { lines: ['belgrave', 'alamein'] });
      expect(socket.join).toHaveBeenCalledWith('line:belgrave');
      expect(socket.join).toHaveBeenCalledWith('line:alamein');
    });

    it('emits vehicles:update with matching vehicles from Redis', async () => {
      const belgraveVehicle = makeVehicle('t1', 'belgrave');
      const otherVehicle    = makeVehicle('t2', 'frankston');
      mockRedis.keys.mockResolvedValue(['vehicle:t1', 'vehicle:t2']);
      mockRedis.mget.mockResolvedValue([
        JSON.stringify(belgraveVehicle),
        JSON.stringify(otherVehicle),
      ]);

      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      await socket.trigger('rooms:join', { lines: ['belgrave'] });

      expect(socket.emit).toHaveBeenCalledWith('vehicles:update', [belgraveVehicle]);
    });

    it('does not emit vehicles:update when no vehicles match the requested lines', async () => {
      mockRedis.keys.mockResolvedValue(['vehicle:t1']);
      mockRedis.mget.mockResolvedValue([JSON.stringify(makeVehicle('t1', 'frankston'))]);

      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      await socket.trigger('rooms:join', { lines: ['belgrave'] });

      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('does not emit vehicles:update when Redis returns no keys', async () => {
      mockRedis.keys.mockResolvedValue([]);

      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      await socket.trigger('rooms:join', { lines: ['belgrave'] });

      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('filters out null entries from Redis mget (expired keys)', async () => {
      const goodVehicle = makeVehicle('t1', 'belgrave');
      mockRedis.keys.mockResolvedValue(['vehicle:t1', 'vehicle:t2']);
      mockRedis.mget.mockResolvedValue([JSON.stringify(goodVehicle), null]);

      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      await socket.trigger('rooms:join', { lines: ['belgrave'] });

      const emitted = socket._emitted.find((e: any) => e.event === 'vehicles:update');
      expect(emitted).toBeTruthy();
      expect(emitted.data).toHaveLength(1);
    });

    it('does not throw when Redis.keys rejects (non-fatal path)', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis down'));

      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      // Should resolve without throwing
      await expect(socket.trigger('rooms:join', { lines: ['belgrave'] })).resolves.toBeDefined();
    });

    it('joins rooms even when Redis initial-state fetch fails', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis down'));

      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      await socket.trigger('rooms:join', { lines: ['belgrave'] });

      expect(socket.join).toHaveBeenCalledWith('line:belgrave');
    });
  });

  describe('rooms:leave', () => {
    it('leaves a socket room for each lineId', () => {
      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      socket.trigger('rooms:leave', { lines: ['belgrave', 'frankston'] });
      expect(socket.leave).toHaveBeenCalledWith('line:belgrave');
      expect(socket.leave).toHaveBeenCalledWith('line:frankston');
    });

    it('leave is synchronous and does not call Redis', () => {
      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      socket.trigger('rooms:leave', { lines: ['belgrave'] });
      expect(mockRedis.keys).not.toHaveBeenCalled();
    });

    it('handles an empty lines array without error', () => {
      const socket = makeSocket();
      registerLineRoomHandlers(socket);
      expect(() => socket.trigger('rooms:leave', { lines: [] })).not.toThrow();
      expect(socket.leave).not.toHaveBeenCalled();
    });
  });
});
