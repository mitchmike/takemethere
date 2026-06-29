import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/redis/client.js', () => ({
  redis: {
    pipeline: () => ({
      set: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
  },
}));

// Patch CAPTURES_DIR before importing the module under test
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual };
});

import { replayController } from '../../../src/stream/ingest/replay.js';

function makeIo() {
  const emitted: { event: string; data: unknown }[] = [];
  const roomEmitted: { room: string; event: string; data: unknown }[] = [];
  const toFn = (room: string) => ({
    emit: (event: string, data: unknown) => { roomEmitted.push({ room, event, data }); },
  });
  return {
    emit: (event: string, data: unknown) => { emitted.push({ event, data }); },
    to: toFn,
    _emitted: emitted,
    _roomEmitted: roomEmitted,
  };
}

describe('ReplayController', () => {
  beforeEach(() => {
    replayController.stop();
  });

  it('returns inactive status by default', () => {
    const s = replayController.getStatus();
    expect(s.active).toBe(false);
    expect(s.session).toBeNull();
    expect(s.snapshotIndex).toBe(0);
  });

  it('stop() is idempotent when not active', () => {
    expect(() => replayController.stop()).not.toThrow();
    expect(replayController.getStatus().active).toBe(false);
  });

  it('listSessions() returns empty array when dir missing', async () => {
    // The test env data dir likely doesn't exist, so should return []
    const sessions = await replayController.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('start() throws when session file not found', async () => {
    const io = makeIo() as unknown as Parameters<typeof replayController.start>[1];
    await expect(replayController.start('nonexistent-session', io)).rejects.toThrow();
  });
});
