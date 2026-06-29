import { describe, it, expect } from 'vitest';
import { computeAlignedPositions } from '../../src/utils/stationOrder.js';
import type { StationSequence } from '../../src/utils/stationOrder.js';

// Fixture: 3 lines sharing some stations
// Line A (reference, most stops): [S1, S2, S3, S4, S5]
// Line B: [S1, S2, SB1, S4]   (SB1 is unique to B, between S2 and S4)
// Line C: [SC1, S3, S4, S5]   (SC1 is unique to C, before S3)
const fixture: StationSequence[] = [
  // Line A
  { lineId: 'a', stopId: 'S1', stopName: 'Stop 1', canonicalPosition: 1 },
  { lineId: 'a', stopId: 'S2', stopName: 'Stop 2', canonicalPosition: 2 },
  { lineId: 'a', stopId: 'S3', stopName: 'Stop 3', canonicalPosition: 3 },
  { lineId: 'a', stopId: 'S4', stopName: 'Stop 4', canonicalPosition: 4 },
  { lineId: 'a', stopId: 'S5', stopName: 'Stop 5', canonicalPosition: 5 },
  // Line B
  { lineId: 'b', stopId: 'S1',  stopName: 'Stop 1',   canonicalPosition: 1 },
  { lineId: 'b', stopId: 'S2',  stopName: 'Stop 2',   canonicalPosition: 2 },
  { lineId: 'b', stopId: 'SB1', stopName: 'Stop B1',  canonicalPosition: 3 },
  { lineId: 'b', stopId: 'S4',  stopName: 'Stop 4',   canonicalPosition: 4 },
  // Line C
  { lineId: 'c', stopId: 'SC1', stopName: 'Stop C1', canonicalPosition: 1 },
  { lineId: 'c', stopId: 'S3',  stopName: 'Stop 3',  canonicalPosition: 2 },
  { lineId: 'c', stopId: 'S4',  stopName: 'Stop 4',  canonicalPosition: 3 },
  { lineId: 'c', stopId: 'S5',  stopName: 'Stop 5',  canonicalPosition: 4 },
];

function getX(lines: ReturnType<typeof computeAlignedPositions>, lineId: string, stopId: string) {
  return lines.find(l => l.lineId === lineId)!.stations.find(s => s.stopId === stopId)!.canonicalX;
}

describe('computeAlignedPositions', () => {
  const result = computeAlignedPositions(fixture);

  it('produces an entry for each line', () => {
    expect(result.map(l => l.lineId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('shared stop S1 has same canonicalX on lines a and b', () => {
    expect(getX(result, 'a', 'S1')).toBeCloseTo(getX(result, 'b', 'S1'));
  });

  it('shared stop S2 has same canonicalX on lines a and b', () => {
    expect(getX(result, 'a', 'S2')).toBeCloseTo(getX(result, 'b', 'S2'));
  });

  it('shared stop S4 has same canonicalX on lines a, b, and c', () => {
    const xA = getX(result, 'a', 'S4');
    const xB = getX(result, 'b', 'S4');
    const xC = getX(result, 'c', 'S4');
    expect(xA).toBeCloseTo(xB);
    expect(xA).toBeCloseTo(xC);
  });

  it('shared stop S5 has same canonicalX on lines a and c', () => {
    expect(getX(result, 'a', 'S5')).toBeCloseTo(getX(result, 'c', 'S5'));
  });

  it('SB1 (line B only) falls between S2 and S4 canonicalX', () => {
    const xS2 = getX(result, 'a', 'S2');
    const xS4 = getX(result, 'a', 'S4');
    const xSB1 = getX(result, 'b', 'SB1');
    expect(xSB1).toBeGreaterThan(xS2);
    expect(xSB1).toBeLessThan(xS4);
  });

  it('all canonicalX values are in [0, 1]', () => {
    for (const line of result) {
      for (const station of line.stations) {
        expect(station.canonicalX).toBeGreaterThanOrEqual(0);
        expect(station.canonicalX).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stations within a line are in ascending canonicalX order', () => {
    for (const line of result) {
      const xs = line.stations.map(s => s.canonicalX);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
      }
    }
  });
});
