import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VehiclePosition } from '@takemethere/shared';
import type { TripUpdateEntry } from './decoder.js';

// Mock ioredis before importing publisher
vi.mock('../redis/client.js', () => ({
  redis: { set: vi.fn().mockResolvedValue('OK'), keys: vi.fn().mockResolvedValue([]) },
  redisSub: { subscribe: vi.fn(), on: vi.fn() },
}));

import {
  setRouteLineMap,
  setLineStopCoords,
  setGlobalStopNames,
  setTripDirections,
  publishPositions,
  getPrevNextStopNames,
  getPublishStats,
  setTripStopTimesCache,
  buildStopTimeNameIndex,
} from './publisher.js';
import type { StopData, StopTimeEntry } from './publisher.js';

// Mock Socket.io server
function makeIo() {
  const emitted: Record<string, unknown[][]> = {};
  const rooms = new Map<string, Set<string>>();
  // Simulate a room with subscribers
  rooms.set('line:belgrave', new Set(['sock1']));
  rooms.set('line:all', new Set(['sock2']));
  return {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => {
        emitted[`${room}:${event}`] = [...(emitted[`${room}:${event}`] ?? []), [data]];
      },
    }),
    sockets: { adapter: { rooms } },
    _emitted: emitted,
  } as any;
}

// Minimal stop list for belgrave line (normalized canonicalX from 0 to 1)
const BELGRAVE_STOPS: StopData[] = [
  { stopId: '12261', stopName: 'Richmond Station',      canonicalX: 0.00, lat: -37.8245, lon: 144.9985 },
  { stopId: '12249', stopName: 'Burnley Station',       canonicalX: 0.10, lat: -37.8254, lon: 145.0124 },
  { stopId: '12245', stopName: 'Hawthorn Station',      canonicalX: 0.20, lat: -37.8202, lon: 145.0258 },
  { stopId: '12242', stopName: 'Glenferrie Station',    canonicalX: 0.30, lat: -37.8198, lon: 145.0378 },
  { stopId: '12239', stopName: 'Auburn Station',        canonicalX: 0.40, lat: -37.8208, lon: 145.0475 },
  { stopId: '11209', stopName: 'Camberwell Station',    canonicalX: 0.50, lat: -37.8248, lon: 145.0574 },
  { stopId: '12207', stopName: 'East Camberwell Station', canonicalX: 0.60, lat: -37.8233, lon: 145.0671 },
];

// A second stop ID for Camberwell used by direction_id=1 trips (the mismatch case)
const CAMBERWELL_ALT_ID = '11208';

function makeVp(overrides: Partial<VehiclePosition> = {}): VehiclePosition {
  return {
    tripId: 'trip-001',
    routeId: 'route-belgrave',
    lat: -37.8210,       // roughly between Hawthorn and Glenferrie
    lon: 145.0310,
    bearing: 90,
    speed: 20,
    timestamp: Math.floor(Date.now() / 1000) - 5,
    currentStopSequence: 3,
    currentStatus: 2,
    ...overrides,
  };
}

function makeTu(overrides: Partial<TripUpdateEntry> = {}): TripUpdateEntry {
  return {
    tripId: 'trip-001',
    routeId: 'route-belgrave',
    delay: 60,
    nextStopId: '12242', // Glenferrie (direct match in stops)
    nextStopSeq: 4,
    nextArrivalEpoch: Math.floor(Date.now() / 1000) + 90,
    allStopUpdates: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setRouteLineMap(new Map([['route-belgrave', 'belgrave']]));
  setLineStopCoords(new Map([['belgrave', BELGRAVE_STOPS]]));
  setTripDirections(new Map([['trip-001', 0]]));
  setGlobalStopNames(new Map([
    ['12261', 'Richmond Station'],
    ['12249', 'Burnley Station'],
    ['12245', 'Hawthorn Station'],
    ['12242', 'Glenferrie Station'],
    ['12239', 'Auburn Station'],
    ['11209', 'Camberwell Station'],
    [CAMBERWELL_ALT_ID, 'Camberwell Station'], // alt stopId for Camberwell
    ['12207', 'East Camberwell Station'],
  ]));
});

describe('publishPositions', () => {
  it('emits vehicles:update to the correct line room', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu()]]));
    expect(io._emitted['line:belgrave:vehicles:update']).toBeDefined();
  });

  it('writes vehicle to Redis', async () => {
    const { redis } = await import('../redis/client.js');
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu()]]));
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      expect.stringContaining('trip-001'),
      expect.any(String),
      'EX',
      120,
    );
  });

  it('emits LivePosition with canonicalX in [0,1]', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu()]]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.canonicalX).toBeGreaterThanOrEqual(0);
    expect(pos.canonicalX).toBeLessThanOrEqual(1);
  });

  it('resolves nextStopCanonicalX when TU nextStopId is in the stop list', async () => {
    const io = makeIo();
    // nextStopId=12242 (Glenferrie) is in BELGRAVE_STOPS with canonicalX=0.30
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu({ nextStopId: '12242' })]]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopCanonicalX).toBe(0.30);
  });

  it('resolves nextStopCanonicalX via name fallback when stopId differs (express train / alt platform)', async () => {
    const io = makeIo();
    // CAMBERWELL_ALT_ID (11208) is NOT in BELGRAVE_STOPS directly,
    // but globalStopNames maps it to 'Camberwell Station' which resolves to canonicalX=0.50
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: CAMBERWELL_ALT_ID })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopCanonicalX).toBe(0.50);
  });

  it('falls back to GPS-derived next stop when TU stop ID is completely unresolvable', async () => {
    const io = makeIo();
    // 'totally-unknown-stop' is not in BELGRAVE_STOPS and not in globalStopNames,
    // so TU lookup and name fallback both fail. GPS projects the train (lat≈−37.821, lon≈145.031)
    // between Hawthorn (cx=0.20) and Glenferrie (cx=0.30), so GPS fallback picks Glenferrie.
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: 'totally-unknown-stop' })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopCanonicalX).toBe(0.30); // Glenferrie — GPS fallback
  });

  it('skips vehicles whose routeId is not in the route map', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp({ routeId: 'unknown-route' })], new Map());
    expect(io._emitted['line:belgrave:vehicles:update']).toBeUndefined();
  });

  it('skips vehicles with no tripId', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp({ tripId: null })], new Map());
    expect(io._emitted['line:belgrave:vehicles:update']).toBeUndefined();
  });

  it('enriches delay from TU entry', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu({ delay: 180 })]]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    expect((positions as any[])[0].delay).toBe(180);
  });

  it('records publish stats after a poll', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu()]]));
    const stats = getPublishStats();
    expect(stats.vehicleCount).toBe(1);
    expect(stats.tuMatchCount).toBe(1);
    expect(stats.unmappedCount).toBe(0);
    expect(stats.snapshotAt).toBeTruthy();
  });

  it('express train: skips Burnley+Hawthorn and routes direct to Glenferrie', async () => {
    // The express trip skips stops between Richmond and Glenferrie.
    // TU's nextStopId = Glenferrie (12242), which should resolve directly.
    const io = makeIo();
    const expressVp = makeVp({ lat: -37.8220, lon: 145.0150 }); // GPS between Richmond and Glenferrie
    await publishPositions(io, [expressVp], new Map([
      ['trip-001', makeTu({ nextStopId: '12242', delay: 0 })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    // canonicalX should be between Richmond (0.0) and Glenferrie (0.3)
    expect(pos.canonicalX).toBeGreaterThanOrEqual(0);
    expect(pos.canonicalX).toBeLessThan(0.3);
    expect(pos.nextStopCanonicalX).toBe(0.30);
  });
});

describe('getPrevNextStopNames', () => {
  it('returns correct prev and next stop for a mid-line position', () => {
    const { prevStopName, nextStopName } = getPrevNextStopNames('belgrave', 0.25, '12242');
    // canonicalX=0.25 → between Hawthorn (0.20) and Glenferrie (0.30)
    expect(prevStopName).toBe('Hawthorn Station');
    expect(nextStopName).toBe('Glenferrie Station');
  });

  it('resolves nextStopName via name fallback for alt stopId', () => {
    const { nextStopName } = getPrevNextStopNames('belgrave', 0.25, CAMBERWELL_ALT_ID);
    expect(nextStopName).toBe('Camberwell Station');
  });

  it('returns null nextStopName when stopId is unknown', () => {
    const { nextStopName } = getPrevNextStopNames('belgrave', 0.25, 'unknown-id');
    expect(nextStopName).toBeNull();
  });

  it('returns null prevStopName when at the very start of the line', () => {
    const { prevStopName } = getPrevNextStopNames('belgrave', -0.01, null);
    expect(prevStopName).toBeNull();
  });

  it('returns null for unknown lineId', () => {
    const result = getPrevNextStopNames('unknown-line', 0.5, '12242');
    expect(result.prevStopName).toBeNull();
    expect(result.nextStopName).toBeNull();
  });
});

// ─── buildStopTimeNameIndex ───────────────────────────────────────────────────

describe('buildStopTimeNameIndex', () => {
  const entries: StopTimeEntry[] = [
    { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36000 }, // Richmond
    { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36060 }, // Burnley
    { seq: 3, stopId: '11208', arrivalSec: 36120, departureSec: 36120 }, // Camberwell alt ID
  ];

  it('indexes entries by normalised stop name', () => {
    const idx = buildStopTimeNameIndex(entries);
    // globalStopNames maps 11208 → 'Camberwell Station' (set in beforeEach)
    expect(idx.has('camberwell')).toBe(true);
    expect(idx.get('camberwell')?.stopId).toBe('11208');
  });

  it('includes entries whose stopId appears in globalStopNames', () => {
    const idx = buildStopTimeNameIndex(entries);
    expect(idx.has('richmond')).toBe(true);
    expect(idx.has('burnley')).toBe(true);
  });

  it('returns empty map for empty input', () => {
    expect(buildStopTimeNameIndex([])).toEqual(new Map());
  });
});

// ─── nextArrivalEpoch — platform ID mismatch ─────────────────────────────────

describe('nextArrivalEpoch with platform stop_id mismatch', () => {
  const now = Math.floor(Date.now() / 1000);
  // Trip uses '11208' (alt Camberwell platform) and '12242' (Glenferrie) in stop_times.
  // The line_station_order view has '11209' for Camberwell and '12242' for Glenferrie.
  // Glenferrie matches by stopId directly; only Camberwell needs the name fallback.
  const STOP_TIMES: StopTimeEntry[] = [
    { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36010 }, // Richmond
    { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36065 }, // Burnley
    { seq: 3, stopId: '12245', arrivalSec: 36120, departureSec: 36125 }, // Hawthorn
    { seq: 4, stopId: '12242', arrivalSec: 36180, departureSec: 36190 }, // Glenferrie — direct match
    { seq: 5, stopId: '11208', arrivalSec: 36300, departureSec: 36310 }, // Camberwell alt ID — name fallback
  ];

  beforeEach(() => {
    setTripStopTimesCache('trip-001', STOP_TIMES);
  });

  it('nextArrivalEpoch is non-zero when next stop matches by stopId', async () => {
    // Train heading toward Glenferrie (stopId=12242 — direct match in stop_times)
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: '12242', delay: 0 })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextArrivalEpoch).toBeGreaterThan(0);
  });

  it('nextArrivalEpoch is non-zero when next stop requires name fallback (alt platform ID)', async () => {
    // TU says next stop is Camberwell (11209 in line_station_order), but the trip's
    // stop_times uses the alt platform ID (11208). The name fallback must resolve it
    // so that nextArrivalEpoch is populated — without this, the streamer returns
    // a static canonicalX for every train.
    const io = makeIo();
    await publishPositions(io, [makeVp({ lat: -37.822, lon: 145.045 })], new Map([
      ['trip-001', makeTu({ nextStopId: '11209', delay: 0 })], // TU uses canonical platform ID
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextArrivalEpoch).toBeGreaterThan(0);
  });
});
