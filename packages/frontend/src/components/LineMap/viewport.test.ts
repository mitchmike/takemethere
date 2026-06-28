import { describe, it, expect } from 'vitest';
import { computeTrainViewport, computeStationViewport, adjustZoomViewport } from './viewport.js';

const STOPS = [
  { canonicalX: 0.0 },  // 0 Flinders
  { canonicalX: 0.1 },  // 1 Richmond
  { canonicalX: 0.2 },  // 2 Hawthorn
  { canonicalX: 0.3 },  // 3 Camberwell
  { canonicalX: 0.5 },  // 4 Box Hill
  { canonicalX: 0.7 },  // 5 Mitcham
  { canonicalX: 0.9 },  // 6 Ringwood
  { canonicalX: 1.0 },  // 7 Belgrave
];

describe('computeTrainViewport', () => {
  it('centers on the train position', () => {
    const vp = computeTrainViewport(0.3, STOPS);
    expect(vp.center).toBe(0.3);
  });

  it('windowHalf spans approximately 3 stops either side', () => {
    // Train at Camberwell (idx 3, cx=0.3). 3rd left = Flinders (idx 0, cx=0.0), 3rd right = Ringwood (idx 6, cx=0.9)
    // max_dist = max(0.3, 0.6) * 1.1 = 0.66, clamped to MAX_WINDOW_HALF=0.65
    const vp = computeTrainViewport(0.3, STOPS);
    expect(vp.windowHalf).toBe(0.65);
  });

  it('clamps windowHalf to MIN_WINDOW_HALF (0.02) for very tight stop clusters', () => {
    const tightStops = [{ canonicalX: 0.5 }, { canonicalX: 0.5001 }];
    const vp = computeTrainViewport(0.5, tightStops);
    expect(vp.windowHalf).toBeGreaterThanOrEqual(0.02);
  });

  it('clamps windowHalf to MAX_WINDOW_HALF (0.65) for a very sparse line', () => {
    const sparseStops = [{ canonicalX: 0 }, { canonicalX: 1 }];
    const vp = computeTrainViewport(0.5, sparseStops);
    expect(vp.windowHalf).toBeLessThanOrEqual(0.65);
  });

  it('handles a train near the start of the line (fewer stops on left)', () => {
    // Train at Richmond (0.1). 3rd left would be out-of-bounds → clamps to Flinders (0.0)
    const vp = computeTrainViewport(0.1, STOPS);
    expect(vp.center).toBe(0.1);
    expect(vp.windowHalf).toBeGreaterThan(0);
  });

  it('handles a train near the end of the line (fewer stops on right)', () => {
    const vp = computeTrainViewport(0.9, STOPS);
    expect(vp.center).toBe(0.9);
    expect(vp.windowHalf).toBeGreaterThan(0);
  });

  it('returns a fallback viewport for an empty stops array', () => {
    const vp = computeTrainViewport(0.5, []);
    expect(vp.center).toBe(0.5);
    expect(vp.windowHalf).toBeGreaterThan(0);
  });
});

describe('computeStationViewport', () => {
  it('centers on the station', () => {
    const vp = computeStationViewport(0.3, STOPS);
    expect(vp.center).toBe(0.3);
  });

  it('windowHalf is wider than train viewport when not clamped', () => {
    // Use a tight stop cluster so train viewport is well below MAX
    const nearStops = [
      { canonicalX: 0.3 }, { canonicalX: 0.35 }, { canonicalX: 0.4 },
      { canonicalX: 0.45 }, { canonicalX: 0.5 }, { canonicalX: 0.55 },
      { canonicalX: 0.6 }, { canonicalX: 0.65 },
    ];
    const train = computeTrainViewport(0.5, nearStops);
    const station = computeStationViewport(0.5, nearStops);
    expect(station.windowHalf).toBeGreaterThan(train.windowHalf);
  });

  it('windowHalf is approximately 2x the train viewport windowHalf when unclamped', () => {
    const nearStops = [
      { canonicalX: 0.3 }, { canonicalX: 0.35 }, { canonicalX: 0.4 },
      { canonicalX: 0.45 }, { canonicalX: 0.5 }, { canonicalX: 0.55 },
      { canonicalX: 0.6 }, { canonicalX: 0.65 },
    ];
    const train = computeTrainViewport(0.5, nearStops);
    const station = computeStationViewport(0.5, nearStops);
    if (train.windowHalf * 2 <= 0.65) {
      expect(station.windowHalf).toBeCloseTo(train.windowHalf * 2, 5);
    }
  });
});

describe('adjustZoomViewport', () => {
  it('zoom out (factor > 1) increases windowHalf', () => {
    const vp = { center: 0.5, windowHalf: 0.2 };
    expect(adjustZoomViewport(vp, 1.25).windowHalf).toBeCloseTo(0.25, 5);
  });

  it('zoom in (factor < 1) decreases windowHalf', () => {
    const vp = { center: 0.5, windowHalf: 0.2 };
    expect(adjustZoomViewport(vp, 0.8).windowHalf).toBeCloseTo(0.16, 5);
  });

  it('center is unchanged by zoom', () => {
    const vp = { center: 0.42, windowHalf: 0.2 };
    expect(adjustZoomViewport(vp, 2).center).toBe(0.42);
  });

  it('clamps windowHalf to MIN_WINDOW_HALF (0.02) when zooming in too far', () => {
    const vp = { center: 0.5, windowHalf: 0.03 };
    expect(adjustZoomViewport(vp, 0.1).windowHalf).toBe(0.02);
  });

  it('clamps windowHalf to MAX_WINDOW_HALF (0.65) when zooming out too far', () => {
    const vp = { center: 0.5, windowHalf: 0.5 };
    expect(adjustZoomViewport(vp, 10).windowHalf).toBe(0.65);
  });
});
