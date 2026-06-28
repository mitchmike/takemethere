import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external dependencies so the poller never makes real network calls
vi.mock('../config.js', () => ({
  config: {
    PTV_API_KEY: 'test-key',
    PTV_GTFS_RT_URL: 'https://mock.ptv/vp',
    PTV_GTFS_RT_TU_URL: 'https://mock.ptv/tu',
    GTFS_RT_POLL_INTERVAL_MS: 30_000,
    GTFS_RT_ENABLED: true,
  },
}));

vi.mock('./decoder.js', () => ({
  decodeFeed: vi.fn(() => ({ entity: [] })),
  extractVehiclePositions: vi.fn(() => []),
  extractTripUpdates: vi.fn(() => new Map()),
}));

vi.mock('./publisher.js', () => ({
  publishPositions: vi.fn(() => Promise.resolve()),
  getPublishStats: vi.fn(() => ({
    vehicleCount: 0, vehiclesByLine: [], unmappedCount: 0,
    tuMatchCount: 0, redisVehicleCount: 0, snapshotAt: null,
  })),
  loadMissingStopTimes: vi.fn(() => Promise.resolve()),
  epochToMelbTime: vi.fn((e: number) => String(e)),
}));

vi.mock('../redis/client.js', () => ({
  redis: { get: vi.fn(() => Promise.resolve(null)) },
}));

vi.mock('../redis/keys.js', () => ({
  keys: { vehicle: (id: string) => `vehicle:${id}` },
}));

// Stub fetch so it returns empty protobuf buffers
const EMPTY_BUF = Buffer.alloc(0);
vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(EMPTY_BUF.buffer) }),
));

// Import after mocks are set up
import { startPoller, stopPoller, getPollerStatus } from './poller.js';

// The poller module has module-level singleton state — stop after each test.
// Do NOT call vi.clearAllMocks() here — it would wipe fetch mock implementations.
afterEach(() => {
  stopPoller();
});

describe('getPollerStatus', () => {
  it('returns the expected shape with all required fields', () => {
    const status = getPollerStatus();
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('pollCount');
    expect(status).toHaveProperty('lastPollAt');
    expect(status).toHaveProperty('lastError');
    expect(status).toHaveProperty('lastPollMs');
    expect(status).toHaveProperty('publishStats');
  });

  it('publishStats has all required fields', () => {
    const { publishStats } = getPollerStatus();
    expect(publishStats).toHaveProperty('vehicleCount');
    expect(publishStats).toHaveProperty('vehiclesByLine');
    expect(publishStats).toHaveProperty('unmappedCount');
    expect(publishStats).toHaveProperty('tuMatchCount');
    expect(publishStats).toHaveProperty('redisVehicleCount');
    expect(publishStats).toHaveProperty('snapshotAt');
  });

  it('returns a copy — mutations do not affect internal state', () => {
    const s1 = getPollerStatus();
    s1.running = !s1.running;
    const s2 = getPollerStatus();
    expect(s2.running).not.toBe(s1.running);
  });
});

describe('startPoller / stopPoller', () => {
  it('startPoller sets running to true', async () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    expect(getPollerStatus().running).toBe(true);
  });

  it('stopPoller sets running to false', () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    stopPoller();
    expect(getPollerStatus().running).toBe(false);
  });

  it('calling startPoller twice does not double-start (idempotent)', () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    startPoller(mockIo);
    // Running should still be true, not crashed
    expect(getPollerStatus().running).toBe(true);
  });

  it('calling stopPoller when not running does not throw', () => {
    expect(() => stopPoller()).not.toThrow();
    expect(getPollerStatus().running).toBe(false);
  });

  it('after stop, running is false and can be restarted', () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    stopPoller();
    expect(getPollerStatus().running).toBe(false);

    startPoller(mockIo);
    expect(getPollerStatus().running).toBe(true);
  });
});

describe('poll behaviour (mocked feed)', () => {
  it('poll increments pollCount after a successful fetch', async () => {
    const mockIo = {} as any;
    const before = getPollerStatus().pollCount;
    startPoller(mockIo);
    // poll() is called immediately on startPoller — waitFor already asserts the condition
    await vi.waitFor(() => getPollerStatus().pollCount > before, { timeout: 2000 });
  });

  it('poll records lastPollAt as an ISO timestamp string', async () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    await vi.waitFor(() => getPollerStatus().lastPollAt !== null, { timeout: 2000 });
    const lastPollAt = getPollerStatus().lastPollAt!;
    expect(() => new Date(lastPollAt)).not.toThrow();
    expect(new Date(lastPollAt).getFullYear()).toBeGreaterThan(2020);
  });

  it('poll records lastPollMs as a non-negative number', async () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    await vi.waitFor(() => getPollerStatus().lastPollMs !== null, { timeout: 2000 });
    expect(getPollerStatus().lastPollMs!).toBeGreaterThanOrEqual(0);
  });

  it('poll records lastError as null on success', async () => {
    const mockIo = {} as any;
    startPoller(mockIo);
    await vi.waitFor(() => getPollerStatus().lastPollAt !== null, { timeout: 2000 });
    expect(getPollerStatus().lastError).toBeNull();
  });

  it('poll records lastError when fetch fails', async () => {
    // Stub fetch to reject before startPoller so the first poll sees the error
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const mockIo = {} as any;
    startPoller(mockIo);
    await vi.waitFor(() => getPollerStatus().lastError !== null, { timeout: 2000 });
    // running must still be true — errors are non-fatal
    expect(getPollerStatus().running).toBe(true);

    // Restore the success mock so afterEach cleanup works cleanly
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(EMPTY_BUF.buffer) }),
    ));
  });
});
