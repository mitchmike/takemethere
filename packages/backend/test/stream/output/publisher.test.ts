import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VehiclePosition } from '@takemethere/shared';
import type { TripUpdateEntry } from '../../../src/stream/ingest/position_decoder.js';

const { pipelineSet, pipelineExec } = vi.hoisted(() => ({
  pipelineSet: vi.fn().mockReturnThis(),
  pipelineExec: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/redis/client.js', () => ({
  redis: {
    pipeline: vi.fn(() => ({ set: pipelineSet, exec: pipelineExec })),
    keys: vi.fn().mockResolvedValue([]),
  },
  redisSub: { subscribe: vi.fn(), on: vi.fn() },
}));

import {
  setRouteLineMap,
  setLineStopCoords,
  setGlobalStopNames,
  setTripDirections,
  getPrevNextStopNames,
  setTripStopTimesCache,
  buildStopTimeNameIndex,
} from '../../../src/stream/engine/static_data.js';
import type { StopData, StopTimeEntry } from '../../../src/stream/engine/static_data.js';
import {
  publishPositions,
  getPublishStats,
} from '../../../src/stream/output/publisher.js';

function makeIo() {
  const emitted: Record<string, unknown[][]> = {};
  const rooms = new Map<string, Set<string>>();
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

const BELGRAVE_STOPS: StopData[] = [
  { stopId: '12261', stopName: 'Richmond Station',      canonicalX: 0.00, lat: -37.8245, lon: 144.9985 },
  { stopId: '12249', stopName: 'Burnley Station',       canonicalX: 0.10, lat: -37.8254, lon: 145.0124 },
  { stopId: '12245', stopName: 'Hawthorn Station',      canonicalX: 0.20, lat: -37.8202, lon: 145.0258 },
  { stopId: '12242', stopName: 'Glenferrie Station',    canonicalX: 0.30, lat: -37.8198, lon: 145.0378 },
  { stopId: '12239', stopName: 'Auburn Station',        canonicalX: 0.40, lat: -37.8208, lon: 145.0475 },
  { stopId: '11209', stopName: 'Camberwell Station',    canonicalX: 0.50, lat: -37.8248, lon: 145.0574 },
  { stopId: '12207', stopName: 'East Camberwell Station', canonicalX: 0.60, lat: -37.8233, lon: 145.0671 },
];

const CAMBERWELL_ALT_ID = '11208';

function makeVp(overrides: Partial<VehiclePosition> = {}): VehiclePosition {
  return {
    tripId: 'trip-001',
    routeId: 'route-belgrave',
    lat: -37.8210,
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
    nextStopId: '12242',
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
    [CAMBERWELL_ALT_ID, 'Camberwell Station'],
    ['12207', 'East Camberwell Station'],
  ]));
});

describe('publishPositions', () => {
  it('emits vehicles:update to the correct line room', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu()]]));
    expect(io._emitted['line:belgrave:vehicles:update']).toBeDefined();
  });

  it('writes vehicle to Redis via pipeline (one set + one exec per poll)', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu()]]));
    expect(pipelineSet).toHaveBeenCalledTimes(1);
    expect(pipelineExec).toHaveBeenCalledTimes(1);
    const [key, , expFlag, ttl] = pipelineSet.mock.calls[0] as [string, string, string, number];
    expect(key).toBe('vehicle:trip-001');
    expect(expFlag).toBe('EX');
    expect(ttl).toBe(120);
  });

  it('pipelines all vehicles in a single exec (not one set per await)', async () => {
    const io = makeIo();
    setRouteLineMap(new Map([['route-belgrave', 'belgrave'], ['route-alamein', 'belgrave']]));
    const vp1 = makeVp({ tripId: 'trip-001', routeId: 'route-belgrave' });
    const vp2 = makeVp({ tripId: 'trip-002', routeId: 'route-belgrave' });
    const tu1 = makeTu({ tripId: 'trip-001' });
    const tu2 = makeTu({ tripId: 'trip-002' });
    await publishPositions(io, [vp1, vp2], new Map([['trip-001', tu1], ['trip-002', tu2]]));
    expect(pipelineSet).toHaveBeenCalledTimes(2);
    expect(pipelineExec).toHaveBeenCalledTimes(1);
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
    await publishPositions(io, [makeVp()], new Map([['trip-001', makeTu({ nextStopId: '12242' })]]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopCanonicalX).toBe(0.30);
  });

  it('resolves nextStopCanonicalX via name fallback when stopId differs', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: CAMBERWELL_ALT_ID })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopCanonicalX).toBe(0.50);
  });

  it('falls back to GPS-derived next stop when TU stop ID is completely unresolvable', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: 'totally-unknown-stop' })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopCanonicalX).toBe(0.30);
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
    const io = makeIo();
    const expressVp = makeVp({ lat: -37.8220, lon: 145.0150 });
    await publishPositions(io, [expressVp], new Map([
      ['trip-001', makeTu({ nextStopId: '12242', delay: 0 })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.canonicalX).toBeGreaterThanOrEqual(0);
    expect(pos.canonicalX).toBeLessThan(0.3);
    expect(pos.nextStopCanonicalX).toBe(0.30);
  });
});

describe('getPrevNextStopNames', () => {
  it('returns correct prev and next stop for a mid-line position', () => {
    const { prevStopName, nextStopName } = getPrevNextStopNames('belgrave', 0.25, '12242');
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

describe('buildStopTimeNameIndex', () => {
  const entries: StopTimeEntry[] = [
    { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36000 },
    { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36060 },
    { seq: 3, stopId: '11208', arrivalSec: 36120, departureSec: 36120 },
  ];

  it('indexes entries by normalised stop name', () => {
    const idx = buildStopTimeNameIndex(entries);
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

describe('publisher trip-terminus override', () => {
  const STOP_TIMES_TERMINUS_CAMBERWELL: StopTimeEntry[] = [
    { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36000 },
    { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36060 },
    { seq: 3, stopId: '12245', arrivalSec: 36120, departureSec: 36120 },
    { seq: 4, stopId: '12242', arrivalSec: 36180, departureSec: 36180 },
    { seq: 5, stopId: '12239', arrivalSec: 36240, departureSec: 36240 },
    { seq: 6, stopId: '11209', arrivalSec: 36300, departureSec: 36300 },
  ];

  beforeEach(() => {
    setTripStopTimesCache('trip-001', STOP_TIMES_TERMINUS_CAMBERWELL);
    setTripDirections(new Map([['trip-001', 0]]));
  });

  it('sets nextStopId=null when TU claims a stop beyond the trip terminus', async () => {
    const io = makeIo();
    const vp = makeVp({ lat: -37.8248, lon: 145.0574 });
    await publishPositions(io, [vp], new Map([
      ['trip-001', makeTu({ nextStopId: '12207' })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopId).toBeNull();
    expect(pos.nextStopCanonicalX).toBe(-1);
  });

  it('sets nextStopId=null when stop_times terminus uses an alt platform ID', async () => {
    const STOP_TIMES_ALT_TERMINUS: StopTimeEntry[] = [
      { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36000 },
      { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36060 },
      { seq: 3, stopId: '12245', arrivalSec: 36120, departureSec: 36120 },
      { seq: 4, stopId: '12242', arrivalSec: 36180, departureSec: 36180 },
      { seq: 5, stopId: '12239', arrivalSec: 36240, departureSec: 36240 },
      { seq: 6, stopId: CAMBERWELL_ALT_ID, arrivalSec: 36300, departureSec: 36300 },
    ];
    setTripStopTimesCache('trip-001', STOP_TIMES_ALT_TERMINUS);

    const io = makeIo();
    const vp = makeVp({ lat: -37.8248, lon: 145.0574 });
    await publishPositions(io, [vp], new Map([
      ['trip-001', makeTu({ nextStopId: '12207' })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopId).toBeNull();
    expect(pos.nextStopCanonicalX).toBe(-1);
  });

  it('does NOT apply terminus override for a non-terminus stop', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: '12242' })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextStopId).not.toBeNull();
    expect(pos.nextStopCanonicalX).toBe(0.30);
  });

  it('prevStopName is Camberwell and nextStopName is null at terminus', async () => {
    const io = makeIo();
    const vp = makeVp({ lat: -37.8248, lon: 145.0574 });
    await publishPositions(io, [vp], new Map([
      ['trip-001', makeTu({ nextStopId: '12207' })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.prevStopName).toBe('Camberwell Station');
    expect(pos.nextStopName).toBeNull();
  });
});

describe('nextArrivalEpoch with platform stop_id mismatch', () => {
  const now = Math.floor(Date.now() / 1000);
  const STOP_TIMES: StopTimeEntry[] = [
    { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36010 },
    { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36065 },
    { seq: 3, stopId: '12245', arrivalSec: 36120, departureSec: 36125 },
    { seq: 4, stopId: '12242', arrivalSec: 36180, departureSec: 36190 },
    { seq: 5, stopId: '11208', arrivalSec: 36300, departureSec: 36310 },
  ];

  beforeEach(() => {
    setTripStopTimesCache('trip-001', STOP_TIMES);
  });

  it('nextArrivalEpoch is non-zero when next stop matches by stopId', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp()], new Map([
      ['trip-001', makeTu({ nextStopId: '12242', delay: 0 })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextArrivalEpoch).toBeGreaterThan(0);
  });

  it('nextArrivalEpoch is non-zero when next stop requires name fallback', async () => {
    const io = makeIo();
    await publishPositions(io, [makeVp({ lat: -37.822, lon: 145.045 })], new Map([
      ['trip-001', makeTu({ nextStopId: '11209', delay: 0 })],
    ]));
    const [[positions]] = io._emitted['line:belgrave:vehicles:update'];
    const pos = (positions as any[])[0];
    expect(pos.nextArrivalEpoch).toBeGreaterThan(0);
  });
});
