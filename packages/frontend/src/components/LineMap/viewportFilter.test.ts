import { describe, it, expect } from 'vitest';
import { filterLinesByViewport } from './viewportFilter.js';
import type { LineDefinition } from '@takemethere/shared';

function makeStop(stopId: string, stopName: string, canonicalX: number) {
  return { lineId: '', stopId, stopName, canonicalX, canonicalPosition: 0, stopLat: 0, stopLon: 0 };
}

function makeLine(lineId: string, stops: ReturnType<typeof makeStop>[]): LineDefinition {
  return { lineId, name: lineId, color: '#000', stops: stops.map(s => ({ ...s, lineId })) };
}

// East Camberwell scenario: Alamein and Glen Waverley share stops up to East Camberwell,
// then diverge. Other unrelated lines should NOT appear just because canonicalX overlaps.

const SHARED_STOPS = [
  makeStop('s1', 'Camberwell Station',      0.30),
  makeStop('s2', 'East Camberwell Station', 0.35),
];

const ALAMEIN = makeLine('alamein', [
  ...SHARED_STOPS,
  makeStop('s3', 'Hartwell Station',  0.40),
  makeStop('s4', 'Burwood Station',   0.45),
  makeStop('s5', 'Ashburton Station', 0.50),
  makeStop('s6', 'Alamein Station',   0.55),
]);

// Glen Waverley shares the first two stops then diverges
const GLEN_WAVERLEY = makeLine('glen-waverley', [
  ...SHARED_STOPS,
  makeStop('s7', 'Canterbury Station',   0.40),  // NOT on Alamein — same cx as Hartwell
  makeStop('s8', 'Chatham Station',      0.45),
  makeStop('s9', 'Surrey Hills Station', 0.50),
  makeStop('s10', 'Glen Waverley Station', 0.80),
]);

// An unrelated line whose stops happen to have canonicalX in the same range
const FRANKSTON = makeLine('frankston', [
  makeStop('f1', 'Caulfield Station',  0.28),
  makeStop('f2', 'Glenhuntly Station', 0.32),   // canonicalX overlaps but NOT on Alamein
  makeStop('f3', 'Ormond Station',     0.38),
  makeStop('f4', 'McKinnon Station',   0.42),
  makeStop('f5', 'Bentleigh Station',  0.47),
]);

// Viewport centred on East Camberwell, covering the shared stops
const VP = { center: 0.425, windowHalf: 0.15 };    // [0.275, 0.575]
const FOCUS = new Set(['camberwell', 'east camberwell', 'hartwell', 'burwood', 'ashburton', 'alamein']);

describe('filterLinesByViewport', () => {
  it('includes the focus line itself', () => {
    const result = filterLinesByViewport([ALAMEIN, GLEN_WAVERLEY, FRANKSTON], VP, FOCUS);
    expect(result.map(l => l.lineId)).toContain('alamein');
  });

  it('includes Glen Waverley because it shares Camberwell and East Camberwell with Alamein', () => {
    const result = filterLinesByViewport([ALAMEIN, GLEN_WAVERLEY, FRANKSTON], VP, FOCUS);
    expect(result.map(l => l.lineId)).toContain('glen-waverley');
  });

  it('excludes Frankston even though its canonicalX overlaps — no shared stop names with Alamein', () => {
    const result = filterLinesByViewport([ALAMEIN, GLEN_WAVERLEY, FRANKSTON], VP, FOCUS);
    expect(result.map(l => l.lineId)).not.toContain('frankston');
  });

  it('excludes a line with zero stops in range', () => {
    const far = makeLine('far', [makeStop('x1', 'Far Away Station', 0.95)]);
    const result = filterLinesByViewport([ALAMEIN, far], VP, FOCUS);
    expect(result.map(l => l.lineId)).not.toContain('far');
  });

  it('excludes a line whose stops are in range but names are not on the focus line', () => {
    const impostor = makeLine('impostor', [
      makeStop('i1', 'Canterbury Station', 0.40),   // cx in range, not on Alamein
      makeStop('i2', 'Surrey Hills Station', 0.48),
    ]);
    const result = filterLinesByViewport([ALAMEIN, impostor], VP, FOCUS);
    expect(result.map(l => l.lineId)).not.toContain('impostor');
  });
});
