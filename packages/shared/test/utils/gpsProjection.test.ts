import { describe, it, expect } from 'vitest';
import { projectToLine } from '../../src/utils/gpsProjection.js';

const STOPS = [
  { stopId: 'f1', canonicalX: 0,    lat: -37.818, lon: 144.967 }, // Flinders St
  { stopId: 'r1', canonicalX: 0.25, lat: -37.824, lon: 145.000 }, // Richmond-ish
  { stopId: 'c1', canonicalX: 0.5,  lat: -37.824, lon: 145.060 }, // Camberwell-ish
  { stopId: 'b1', canonicalX: 1,    lat: -37.902, lon: 145.355 }, // Belgrave
];

describe('projectToLine', () => {
  it('returns -1 for empty stops', () => {
    expect(projectToLine(-37.82, 144.97, [])).toBe(-1);
  });

  it('returns the only stop canonicalX for single stop', () => {
    expect(projectToLine(-37.99, 145.99, [{ stopId: 'X', canonicalX: 0.42, lat: -37.818, lon: 144.967 }])).toBe(0.42);
  });

  it('returns 0 for a point exactly at the first stop', () => {
    const result = projectToLine(STOPS[0].lat, STOPS[0].lon, STOPS);
    expect(result).toBeCloseTo(0, 5);
  });

  it('returns 1 for a point exactly at the last stop', () => {
    const result = projectToLine(STOPS[STOPS.length - 1].lat, STOPS[STOPS.length - 1].lon, STOPS);
    expect(result).toBeCloseTo(1, 5);
  });

  it('returns ~0.5 for a point at the middle stop', () => {
    const result = projectToLine(STOPS[2].lat, STOPS[2].lon, STOPS);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('returns value between 0 and 0.25 for a point between first two stops', () => {
    // Midpoint between stop 0 and stop 1
    const midLat = (STOPS[0].lat + STOPS[1].lat) / 2;
    const midLon = (STOPS[0].lon + STOPS[1].lon) / 2;
    const result = projectToLine(midLat, midLon, STOPS);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.25);
    expect(result).toBeCloseTo(0.125, 3);
  });

  it('clamps points past the end of the line to canonicalX=1', () => {
    // Far beyond the last stop
    const result = projectToLine(-38.5, 146.0, STOPS);
    expect(result).toBeCloseTo(1, 2);
  });

  it('clamps points before the start of the line to canonicalX=0', () => {
    // Far before the first stop
    const result = projectToLine(-37.7, 144.8, STOPS);
    expect(result).toBeCloseTo(0, 2);
  });

  it('always returns a value in [0,1] for points near the line', () => {
    // Various points roughly along the Belgrave line corridor
    const testPoints = [
      { lat: -37.820, lon: 144.975 },
      { lat: -37.822, lon: 145.010 },
      { lat: -37.830, lon: 145.100 },
      { lat: -37.860, lon: 145.200 },
    ];
    for (const pt of testPoints) {
      const result = projectToLine(pt.lat, pt.lon, STOPS);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});
