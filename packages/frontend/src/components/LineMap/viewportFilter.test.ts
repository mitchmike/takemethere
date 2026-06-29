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

// Station-click scenario: when a stop is served by multiple lines, focusStopNames is the
// UNION of all those lines' stops. All serving lines must pass the filter regardless of
// which line was used to construct the union.
describe('filterLinesByViewport — station-click multi-line union', () => {
  // Three lines converge at Parliament and Richmond, then diverge
  const CITY_STOPS = [
    makeStop('c1', 'Flinders Street Station', 0.01),
    makeStop('c2', 'Flagstaff Station',       0.04),
    makeStop('c3', 'Parliament Station',      0.07),
    makeStop('c4', 'Richmond Station',        0.10),
  ];

  const BELGRAVE = makeLine('belgrave', [
    ...CITY_STOPS,
    makeStop('b1', 'Burnley Station',   0.14),
    makeStop('b2', 'Hawthorn Station',  0.18),
    makeStop('b3', 'Camberwell Station',0.22),
  ]);

  const LILYDALE = makeLine('lilydale', [
    ...CITY_STOPS,
    makeStop('l1', 'Burnley Station',   0.14),
    makeStop('l2', 'Hawthorn Station',  0.18),
    makeStop('l3', 'Ringwood Station',  0.35),
  ]);

  // A line that shares only city loop stops (no Burnley/Hawthorn)
  const FRANKSTON2 = makeLine('frankston', [
    ...CITY_STOPS,
    makeStop('f1', 'South Yarra Station', 0.13),
    makeStop('f2', 'Caulfield Station',   0.20),
  ]);

  // focusStopNames built by taking the UNION of all lines that serve 'Parliament Station'
  // (Belgrave ∪ Lilydale ∪ Frankston) — this is what LineMap now computes
  const UNION_FOCUS = new Set([
    'flinders street', 'flagstaff', 'parliament', 'richmond',
    'burnley', 'hawthorn', 'camberwell',   // from belgrave
    'ringwood',                             // from lilydale
    'south yarra', 'caulfield',             // from frankston
  ]);

  const VP_PARLIAMENT = { center: 0.07, windowHalf: 0.12 };  // [−0.05, 0.19]

  it('includes all three lines serving Parliament when focusStopNames is the union', () => {
    const result = filterLinesByViewport([BELGRAVE, LILYDALE, FRANKSTON2], VP_PARLIAMENT, UNION_FOCUS);
    expect(result.map(l => l.lineId)).toContain('belgrave');
    expect(result.map(l => l.lineId)).toContain('lilydale');
    expect(result.map(l => l.lineId)).toContain('frankston');
  });

  it('excludes a line with no stops in the viewport even with union focusStopNames', () => {
    const outer = makeLine('outer', [makeStop('o1', 'Far End Station', 0.95)]);
    const result = filterLinesByViewport([BELGRAVE, LILYDALE, FRANKSTON2, outer], VP_PARLIAMENT, UNION_FOCUS);
    expect(result.map(l => l.lineId)).not.toContain('outer');
  });

  it('excludes a truly unrelated line even when its canonicalX overlaps the viewport', () => {
    // An unrelated line with stops in [−0.05, 0.19] but none of those stops are in UNION_FOCUS
    const unrelated = makeLine('unrelated', [
      makeStop('u1', 'Mystery Stop Station', 0.08),  // cx in range, NOT in union focus names
    ]);
    const result = filterLinesByViewport([BELGRAVE, unrelated], VP_PARLIAMENT, UNION_FOCUS);
    expect(result.map(l => l.lineId)).not.toContain('unrelated');
  });
});
