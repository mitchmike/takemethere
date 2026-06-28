import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LivePosition } from '@takemethere/shared';
import {
  computeInterpolatedX,
  tryAdvanceSegment,
} from '../../../src/stream/engine/linear_interp.js';
import {
  updateLivePosition,
  removeLivePosition,
  isAtTripTerminus,
  getTripLastStopId,
} from '../../../src/stream/engine/position_store.js';

vi.mock('../../../src/redis/client.js', () => ({
  redis: { set: vi.fn().mockResolvedValue('OK'), keys: vi.fn().mockResolvedValue([]) },
  redisSub: { subscribe: vi.fn(), on: vi.fn() },
}));

import { setLineStopCoords, setGlobalStopNames, setTripStopTimesCache } from '../../../src/stream/engine/static_data.js';
import type { StopData } from '../../../src/stream/engine/static_data.js';

const BELGRAVE_STOPS: StopData[] = [
  { stopId: '12261', stopName: 'Richmond Station',        canonicalX: 0.00, lat: -37.8245, lon: 144.9985 },
  { stopId: '12249', stopName: 'Burnley Station',         canonicalX: 0.10, lat: -37.8254, lon: 145.0124 },
  { stopId: '12245', stopName: 'Hawthorn Station',        canonicalX: 0.20, lat: -37.8202, lon: 145.0258 },
  { stopId: '12242', stopName: 'Glenferrie Station',      canonicalX: 0.30, lat: -37.8198, lon: 145.0378 },
  { stopId: '12239', stopName: 'Auburn Station',          canonicalX: 0.40, lat: -37.8208, lon: 145.0475 },
  { stopId: '11209', stopName: 'Camberwell Station',      canonicalX: 0.50, lat: -37.8248, lon: 145.0574 },
  { stopId: '12207', stopName: 'East Camberwell Station', canonicalX: 0.60, lat: -37.8233, lon: 145.0671 },
];

beforeEach(() => {
  setLineStopCoords(new Map([['belgrave', BELGRAVE_STOPS]]));
  setGlobalStopNames(new Map(BELGRAVE_STOPS.map(s => [s.stopId, s.stopName])));
});

function makePos(overrides: Partial<LivePosition> = {}): LivePosition {
  const now = Math.floor(Date.now() / 1000);
  return {
    tripId: 'trip-001',
    lineId: 'belgrave',
    lat: -37.82,
    lon: 145.026,
    bearing: 90,
    timestamp: now,
    canonicalX: 0.20,

    prevStopId: '12245',
    prevStopName: 'Hawthorn Station',
    prevStopCanonicalX: 0.20,

    nextStopId: '12242',
    nextStopName: 'Glenferrie Station',
    nextStopCanonicalX: 0.30,

    scheduledNextArrivalEpoch: now - 10,
    nextArrivalEpoch: now - 10,
    predictedNextArrivalEpoch: now + 60,

    delay: 10,
    segmentSpeedKmh: 60,
    directionId: 0,
    upcomingStops: [],
    ...overrides,
  };
}

describe('isAtTripTerminus', () => {
  beforeEach(() => {
    setTripStopTimesCache('trip-001', [
      { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36010 },
      { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36065 },
      { seq: 3, stopId: '11209', arrivalSec: 36180, departureSec: 36190 },
    ]);
  });

  it('returns true when stopId matches the last scheduled stop', () => {
    expect(isAtTripTerminus('trip-001', '11209', 'Camberwell Station')).toBe(true);
  });

  it('returns false for a mid-trip stop', () => {
    expect(isAtTripTerminus('trip-001', '12249', 'Burnley Station')).toBe(false);
  });

  it('returns true via name fallback when stopId is an alternate platform ID', () => {
    setGlobalStopNames(new Map([
      ...BELGRAVE_STOPS.map(s => [s.stopId, s.stopName] as [string, string]),
      ['11209-alt', 'Camberwell Station'],
    ]));
    expect(isAtTripTerminus('trip-001', '11209-alt', 'Camberwell Station')).toBe(true);
  });

  it('returns false for unknown tripId', () => {
    expect(isAtTripTerminus('unknown-trip', '11209', 'Camberwell Station')).toBe(false);
  });
});

describe('getTripLastStopId', () => {
  it('returns the last stopId in the trip schedule', () => {
    setTripStopTimesCache('trip-001', [
      { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36010 },
      { seq: 2, stopId: '11209', arrivalSec: 36180, departureSec: 36190 },
    ]);
    expect(getTripLastStopId('trip-001')).toBe('11209');
  });

  it('returns null for unknown tripId', () => {
    expect(getTripLastStopId('no-such-trip')).toBeNull();
  });
});

describe('computeInterpolatedX', () => {
  it('returns canonicalX immediately after GPS fix (t=0)', () => {
    const pos = makePos();
    const x = computeInterpolatedX(pos, pos.timestamp);
    expect(x).toBeCloseTo(0.20, 4);
  });

  it('returns a position between prev and next stop 30 seconds later', () => {
    const pos = makePos();
    const x = computeInterpolatedX(pos, pos.timestamp + 30);
    expect(x).toBeCloseTo(0.25, 2);
  });

  it('clamps at nextStopCanonicalX when elapsed >= total', () => {
    const pos = makePos();
    const x = computeInterpolatedX(pos, pos.timestamp + 120);
    expect(x).toBeCloseTo(0.30, 4);
  });

  it('TRAIN MOVES: position at t+1 is greater than at t (outbound)', () => {
    const pos = makePos();
    const x0 = computeInterpolatedX(pos, pos.timestamp + 10);
    const x1 = computeInterpolatedX(pos, pos.timestamp + 20);
    expect(x1).toBeGreaterThan(x0);
  });

  it('TRAIN MOVES: position at t+1 is less than at t (inbound, decreasing cx)', () => {
    const now = Math.floor(Date.now() / 1000);
    const pos = makePos({
      canonicalX: 0.30,
      prevStopCanonicalX: 0.30,
      nextStopCanonicalX: 0.20,
      directionId: 1,
    });
    const x0 = computeInterpolatedX(pos, now + 10);
    const x1 = computeInterpolatedX(pos, now + 20);
    expect(x1).toBeLessThan(x0);
  });

  it('uses predictedNextArrivalEpoch even when nextArrivalEpoch is in the past', () => {
    const pos = makePos();
    expect(pos.nextArrivalEpoch).toBeLessThan(pos.timestamp);
    expect(pos.predictedNextArrivalEpoch).toBeGreaterThan(pos.timestamp);

    const x30 = computeInterpolatedX(pos, pos.timestamp + 30);
    expect(x30).toBeGreaterThan(pos.canonicalX);
  });

  it('returns static canonicalX when both nextArrivalEpoch and predictedNextArrivalEpoch are 0', () => {
    const pos = makePos({ nextArrivalEpoch: 0, predictedNextArrivalEpoch: 0 });
    const x = computeInterpolatedX(pos, pos.timestamp + 30);
    expect(x).toBeCloseTo(0.20, 4);
  });

  it('returns static canonicalX when nextStopCanonicalX is -1 (no next stop resolved)', () => {
    const pos = makePos({ nextStopCanonicalX: -1 });
    const x = computeInterpolatedX(pos, pos.timestamp + 30);
    expect(x).toBeCloseTo(0.20, 4);
  });

  it('returns static canonicalX when the gap to next stop is negligible (<0.002)', () => {
    const pos = makePos({ nextStopCanonicalX: 0.2005 });
    const x = computeInterpolatedX(pos, pos.timestamp + 30);
    expect(x).toBeCloseTo(0.20, 2);
  });

  it('returns static canonicalX when canonicalX is already at next stop', () => {
    const pos = makePos({ canonicalX: 0.30 });
    const x = computeInterpolatedX(pos, pos.timestamp + 30);
    expect(x).toBeCloseTo(0.30, 4);
  });
});

describe('tryAdvanceSegment', () => {
  const now = Math.floor(Date.now() / 1000);

  const STOP_TIMES = [
    { seq: 1, stopId: '12261', arrivalSec: 36000, departureSec: 36010 },
    { seq: 2, stopId: '12249', arrivalSec: 36060, departureSec: 36065 },
    { seq: 3, stopId: '12245', arrivalSec: 36120, departureSec: 36125 },
    { seq: 4, stopId: '12242', arrivalSec: 36180, departureSec: 36190 },
    { seq: 5, stopId: '12239', arrivalSec: 36300, departureSec: 36310 },
    { seq: 6, stopId: '11209', arrivalSec: 36400, departureSec: 36410 },
  ];

  beforeEach(() => {
    setTripStopTimesCache('trip-001', STOP_TIMES);
  });

  function makeMidPos(overrides: Partial<LivePosition> = {}): LivePosition {
    return {
      tripId: 'trip-001', lineId: 'belgrave',
      lat: -37.82, lon: 145.038, bearing: 90, timestamp: now,
      canonicalX: 0.25, directionId: 0,
      prevStopId: '12249', prevStopName: 'Burnley Station',   prevStopCanonicalX: 0.10,
      nextStopId: '12245', nextStopName: 'Hawthorn Station',  nextStopCanonicalX: 0.20,
      scheduledNextArrivalEpoch: 0, nextArrivalEpoch: 0, predictedNextArrivalEpoch: now + 60,
      delay: 0, segmentSpeedKmh: 60, upcomingStops: [],
      ...overrides,
    };
  }

  it('returns null when interpX has not yet reached nextStopCanonicalX', () => {
    const pos = makeMidPos();
    expect(tryAdvanceSegment(pos, 0.19, now)).toBeNull();
  });

  it('advances segment when interpX reaches nextStopCanonicalX (outbound)', () => {
    const pos = makeMidPos();
    const advanced = tryAdvanceSegment(pos, 0.20, now);
    expect(advanced).not.toBeNull();
    expect(advanced!.prevStopId).toBe('12245');
    expect(advanced!.prevStopName).toBe('Hawthorn Station');
    expect(advanced!.nextStopId).toBe('12242');
    expect(advanced!.nextStopName).toBe('Glenferrie Station');
    expect(advanced!.canonicalX).toBeCloseTo(0.20, 4);
  });

  it('predictedNextArrivalEpoch is in the future after advance', () => {
    const pos = makeMidPos();
    const advanced = tryAdvanceSegment(pos, 0.20, now);
    expect(advanced!.predictedNextArrivalEpoch).toBeGreaterThan(now);
  });

  it('detects trip terminus mid-line: stops at Camberwell even though East Camberwell is next on the line', () => {
    const pos = makeMidPos({
      prevStopId: '12239', prevStopName: 'Auburn Station',     prevStopCanonicalX: 0.40,
      nextStopId: '11209', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.50,
    });
    const advanced = tryAdvanceSegment(pos, 0.50, now);
    expect(advanced).not.toBeNull();
    expect(advanced!.prevStopId).toBe('11209');
    expect(advanced!.nextStopId).toBeNull();
    expect(advanced!.nextStopCanonicalX).toBe(-1);
  });

  it('inbound: trip terminating at Burnley returns nextStopId=null, not Richmond', () => {
    setTripStopTimesCache('trip-inbound-burnley', [
      { seq: 1, stopId: '11209', arrivalSec: 36000, departureSec: 36010 },
      { seq: 2, stopId: '12207', arrivalSec: 36060, departureSec: 36065 },
      { seq: 3, stopId: '12245', arrivalSec: 36120, departureSec: 36125 },
      { seq: 4, stopId: '12249', arrivalSec: 36180, departureSec: 36190 },
    ]);
    const pos = makeMidPos({
      tripId: 'trip-inbound-burnley',
      directionId: 1,
      prevStopId: '12245', prevStopName: 'Hawthorn Station', prevStopCanonicalX: 0.20,
      nextStopId: '12249', nextStopName: 'Burnley Station',  nextStopCanonicalX: 0.10,
    });
    const advanced = tryAdvanceSegment(pos, 0.10, now);
    expect(advanced).not.toBeNull();
    expect(advanced!.prevStopId).toBe('12249');
    expect(advanced!.nextStopId).toBeNull();
    expect(advanced!.nextStopCanonicalX).toBe(-1);
  });

  it('updateLivePosition terminus guard: GPS poll cannot reset a train already at terminus', () => {
    const terminusPos: LivePosition = {
      ...makeMidPos(),
      canonicalX: 0.60,
      prevStopId: '12207', prevStopName: 'East Camberwell Station', prevStopCanonicalX: 0.60,
      nextStopId: null, nextStopName: null, nextStopCanonicalX: -1,
      predictedNextArrivalEpoch: 0,
    };
    removeLivePosition('trip-001');
    updateLivePosition(terminusPos);

    const gpsPollPos: LivePosition = {
      ...makeMidPos(),
      canonicalX: 0.58,
      prevStopId: '11209', prevStopName: 'Camberwell Station',      prevStopCanonicalX: 0.50,
      nextStopId: '12207', nextStopName: 'East Camberwell Station', nextStopCanonicalX: 0.60,
      predictedNextArrivalEpoch: now + 30,
    };
    updateLivePosition(gpsPollPos);

    const interpX = computeInterpolatedX(terminusPos, now + 60);
    expect(interpX).toBeCloseTo(0.60, 4);
  });

  it('advances by name fallback when nextStopId uses an alternate platform ID', () => {
    setGlobalStopNames(new Map([
      ...BELGRAVE_STOPS.map(s => [s.stopId, s.stopName] as [string, string]),
      ['HAW-PLATFORM-2', 'Hawthorn Station'],
    ]));
    const pos = makeMidPos({
      nextStopId: 'HAW-PLATFORM-2', nextStopName: 'Hawthorn Station', nextStopCanonicalX: 0.20,
    });
    const advanced = tryAdvanceSegment(pos, 0.20, now);
    expect(advanced).not.toBeNull();
    expect(advanced!.prevStopId).toBe('12245');
  });

  it('returns null when neither stopId nor stopName is found in the line stop list', () => {
    const pos = makeMidPos({
      nextStopId: 'unknown-stop', nextStopName: 'Atlantis Station', nextStopCanonicalX: 0.20,
    });
    expect(tryAdvanceSegment(pos, 0.20, now)).toBeNull();
  });

  it('returns pos with nextStopId=null when advancing past the last stop in the line', () => {
    const pos = makeMidPos({
      prevStopId: '11209', prevStopName: 'Camberwell Station',      prevStopCanonicalX: 0.50,
      nextStopId: '12207', nextStopName: 'East Camberwell Station', nextStopCanonicalX: 0.60,
    });
    const advanced = tryAdvanceSegment(pos, 0.60, now);
    expect(advanced).not.toBeNull();
    expect(advanced!.prevStopId).toBe('12207');
    expect(advanced!.nextStopId).toBeNull();
    expect(advanced!.nextStopCanonicalX).toBe(-1);
  });

  it('advances segment inbound (decreasing cx)', () => {
    const pos = makeMidPos({
      directionId: 1,
      canonicalX: 0.25,
      prevStopId: '12245', prevStopName: 'Hawthorn Station',   prevStopCanonicalX: 0.20,
      nextStopId: '12249', nextStopName: 'Burnley Station',    nextStopCanonicalX: 0.10,
    });
    const advanced = tryAdvanceSegment(pos, 0.10, now);
    expect(advanced).not.toBeNull();
    expect(advanced!.prevStopId).toBe('12249');
    expect(advanced!.nextStopId).toBe('12261');
  });
});
