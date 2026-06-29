import { describe, it, expect } from 'vitest';
import { computeSharedStopLayout, SHARE_FACTOR } from '../../../src/components/LineMap/sharedStopLayout.js';
import type { LineDefinition } from '@takemethere/shared';

// ---------------------------------------------------------------------------
// Test fixtures — a simplified Melbourne eastern-lines topology
// ---------------------------------------------------------------------------

function makeStop(stopId: string, stopName: string, canonicalX: number) {
  return { lineId: '', stopId, stopName, canonicalX, canonicalPosition: 0, stopLat: 0, stopLon: 0 };
}
function makeLine(lineId: string, stops: ReturnType<typeof makeStop>[]): LineDefinition {
  return { lineId, name: lineId, color: '#000', stops: stops.map(s => ({ ...s, lineId })) };
}

const STRIP_HEIGHT = 155;
const Y_OFFSET     = 65;   // rail line y within each strip

// Shared city-loop stops (on all four eastern lines)
const CITY_STOPS = [
  makeStop('fl', 'Flinders Street Station', 0.01),
  makeStop('ri', 'Richmond Station',        0.10),
];

// Shared Burnley-group stops (Belgrave, Lilydale, Glen Waverley — NOT Alamein)
const BURNLEY_GROUP = [
  makeStop('bu', 'Burnley Station',   0.15),
  makeStop('ha', 'Hawthorn Station',  0.18),
  makeStop('ca', 'Camberwell Station', 0.22),
];

const BELGRAVE = makeLine('belgrave', [
  ...CITY_STOPS,
  ...BURNLEY_GROUP,
  makeStop('ct', 'Canterbury Station', 0.26),
]);

const LILYDALE = makeLine('lilydale', [
  ...CITY_STOPS,
  ...BURNLEY_GROUP,
  makeStop('ct2', 'Canterbury Station', 0.26),
  makeStop('ch',  'Chatham Station',    0.29),
]);

const GLEN = makeLine('glen', [
  ...CITY_STOPS,
  ...BURNLEY_GROUP,
  makeStop('em', 'East Malvern Station', 0.28),
  makeStop('hn', 'Heynington Station',   0.32),
]);

// Alamein diverges after Richmond — does NOT share Burnley group
const ALAMEIN = makeLine('alamein', [
  ...CITY_STOPS,
  makeStop('er', 'East Richmond Station', 0.13),
  makeStop('gc', 'Gardiner Station',      0.20),
]);

// Full viewport covering all fixtures
const VP_ALL = { center: 0.20, windowHalf: 0.25 }; // [−0.05, 0.45]

// lineY helpers
const lineY = (i: number) => i * STRIP_HEIGHT + Y_OFFSET;
// Strips for [Alamein=0, Belgrave=1, Lilydale=2, Glen=3]
const Y_AL = lineY(0); // 65
const Y_BE = lineY(1); // 220
const Y_LI = lineY(2); // 375
const Y_GL = lineY(3); // 530

// ---------------------------------------------------------------------------

describe('computeSharedStopLayout — basic edge cases', () => {
  it('returns empty layout for a single line', () => {
    const { sharedYs, sharedNames } = computeSharedStopLayout([BELGRAVE], VP_ALL, STRIP_HEIGHT, Y_OFFSET);
    expect(sharedYs.size).toBe(0);
    expect(sharedNames.size).toBe(0);
  });

  it('returns empty layout when viewport is empty (windowHalf=0)', () => {
    const { sharedYs, sharedNames } = computeSharedStopLayout(
      [BELGRAVE, LILYDALE], { center: 0.5, windowHalf: 0 }, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedYs.size).toBe(0);
    expect(sharedNames.size).toBe(0);
  });

  it('stops outside the viewport do not count as shared', () => {
    // Narrow viewport: only covers Burnley area [0.08, 0.22], not Flinders Street (0.01)
    const narrowVP = { center: 0.15, windowHalf: 0.07 };
    const { sharedNames } = computeSharedStopLayout([BELGRAVE, LILYDALE], narrowVP, STRIP_HEIGHT, Y_OFFSET);
    expect(sharedNames.has('flinders street')).toBe(false);
    expect(sharedNames.has('burnley')).toBe(true);
  });
});

describe('computeSharedStopLayout — sharedNames', () => {
  it('marks city-loop stops (on all 4 lines) as shared', () => {
    const { sharedNames } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedNames.has('flinders street')).toBe(true);
    expect(sharedNames.has('richmond')).toBe(true);
  });

  it('marks Burnley-group stops as shared (appear on 3 of 4 lines)', () => {
    const { sharedNames } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedNames.has('burnley')).toBe(true);
    expect(sharedNames.has('hawthorn')).toBe(true);
    expect(sharedNames.has('camberwell')).toBe(true);
  });

  it('marks Canterbury as shared (Belgrave + Lilydale only)', () => {
    const { sharedNames } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedNames.has('canterbury')).toBe(true);
  });

  it('does NOT mark Alamein-only stops as shared', () => {
    const { sharedNames } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedNames.has('east richmond')).toBe(false);
    expect(sharedNames.has('gardiner')).toBe(false);
  });

  it('does NOT mark Glen-only stops as shared', () => {
    const { sharedNames } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedNames.has('heynington')).toBe(false);
    expect(sharedNames.has('east malvern')).toBe(false);
  });
});

describe('computeSharedStopLayout — per-group midpoints (core correctness)', () => {
  it('Richmond (all 4 lines): uses the 4-line average as group midpoint', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    // lineYs = [65, 220, 375, 530], avg = 297.5
    const midY = (Y_AL + Y_BE + Y_LI + Y_GL) / 4; // 297.5
    expect(sharedYs.get('alamein')?.get('richmond')).toBeCloseTo(Y_AL + SHARE_FACTOR * (midY - Y_AL));
    expect(sharedYs.get('belgrave')?.get('richmond')).toBeCloseTo(Y_BE + SHARE_FACTOR * (midY - Y_BE));
    expect(sharedYs.get('lilydale')?.get('richmond')).toBeCloseTo(Y_LI + SHARE_FACTOR * (midY - Y_LI));
    expect(sharedYs.get('glen')?.get('richmond')).toBeCloseTo(Y_GL + SHARE_FACTOR * (midY - Y_GL));
  });

  it('Burnley (Belgrave, Lilydale, Glen only): uses their 3-line average — NOT the 4-line midpoint', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    const midY = (Y_BE + Y_LI + Y_GL) / 3; // 375
    expect(sharedYs.get('belgrave')?.get('burnley')).toBeCloseTo(Y_BE + SHARE_FACTOR * (midY - Y_BE));
    expect(sharedYs.get('lilydale')?.get('burnley')).toBeCloseTo(Y_LI + SHARE_FACTOR * (midY - Y_LI));
    expect(sharedYs.get('glen')?.get('burnley')).toBeCloseTo(Y_GL + SHARE_FACTOR * (midY - Y_GL));
  });

  it('Canterbury (Belgrave + Lilydale): uses their 2-line average', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    const midY = (Y_BE + Y_LI) / 2; // 297.5
    expect(sharedYs.get('belgrave')?.get('canterbury')).toBeCloseTo(Y_BE + SHARE_FACTOR * (midY - Y_BE));
    expect(sharedYs.get('lilydale')?.get('canterbury')).toBeCloseTo(Y_LI + SHARE_FACTOR * (midY - Y_LI));
  });

  it('Burnley y for Belgrave + Lilydale + Glen all differ from the 4-line Richmond midpoint', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    const richmondMidY = (Y_AL + Y_BE + Y_LI + Y_GL) / 4; // 297.5
    const burnleyMidY  = (Y_BE + Y_LI + Y_GL) / 3;         // 375

    // They differ, proving the group midpoint is used (not the global one)
    expect(richmondMidY).not.toBeCloseTo(burnleyMidY);

    const belgraveBurnley = sharedYs.get('belgrave')!.get('burnley')!;
    const belgraveRichmond = sharedYs.get('belgrave')!.get('richmond')!;
    // Belgrave at Burnley uses mid=375; at Richmond uses mid=297.5
    // 220 + 0.6*(375-220) = 313;  220 + 0.6*(297.5-220) = 266.5
    expect(belgraveBurnley).toBeGreaterThan(belgraveRichmond);
  });
});

describe('computeSharedStopLayout — Alamein isolation', () => {
  it('Alamein has NO sharedY entry for Burnley (it is not on that line)', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedYs.get('alamein')?.has('burnley')).toBeFalsy();
    expect(sharedYs.get('alamein')?.has('hawthorn')).toBeFalsy();
    expect(sharedYs.get('alamein')?.has('camberwell')).toBeFalsy();
  });

  it('Glen has NO sharedY entry for Canterbury (it is not on that line)', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    expect(sharedYs.get('glen')?.has('canterbury')).toBeFalsy();
  });
});

describe('computeSharedStopLayout — no-crossing invariant', () => {
  // The y ordering of participating strips must be preserved at every shared stop.
  // Violation = crossing lines.
  it('Richmond: y order matches strip order (Alamein < Belgrave < Lilydale < Glen)', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    const al = sharedYs.get('alamein')!.get('richmond')!;
    const be = sharedYs.get('belgrave')!.get('richmond')!;
    const li = sharedYs.get('lilydale')!.get('richmond')!;
    const gl = sharedYs.get('glen')!.get('richmond')!;
    expect(al).toBeLessThan(be);
    expect(be).toBeLessThan(li);
    expect(li).toBeLessThan(gl);
  });

  it('Burnley: y order matches strip order (Belgrave < Lilydale < Glen)', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    const be = sharedYs.get('belgrave')!.get('burnley')!;
    const li = sharedYs.get('lilydale')!.get('burnley')!;
    const gl = sharedYs.get('glen')!.get('burnley')!;
    expect(be).toBeLessThan(li);
    expect(li).toBeLessThan(gl);
  });

  it('Canterbury: y order matches strip order (Belgrave < Lilydale)', () => {
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET,
    );
    const be = sharedYs.get('belgrave')!.get('canterbury')!;
    const li = sharedYs.get('lilydale')!.get('canterbury')!;
    expect(be).toBeLessThan(li);
  });

  it('shareFactor=0 leaves each line at its own lineY', () => {
    // Use Canterbury (Belgrave+Lilydale only) so Y_BE/Y_LI strip indices are correct
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET, 0,
    );
    expect(sharedYs.get('belgrave')?.get('canterbury')).toBeCloseTo(Y_BE);
    expect(sharedYs.get('lilydale')?.get('canterbury')).toBeCloseTo(Y_LI);
  });

  it('shareFactor=1 merges all participating lines to the group midpoint', () => {
    // Use Canterbury (Belgrave+Lilydale only) so Y_BE/Y_LI strip indices are correct
    const { sharedYs } = computeSharedStopLayout(
      [ALAMEIN, BELGRAVE, LILYDALE, GLEN], VP_ALL, STRIP_HEIGHT, Y_OFFSET, 1,
    );
    const midY = (Y_BE + Y_LI) / 2;
    expect(sharedYs.get('belgrave')?.get('canterbury')).toBeCloseTo(midY);
    expect(sharedYs.get('lilydale')?.get('canterbury')).toBeCloseTo(midY);
  });
});

describe('computeSharedStopLayout — duplicate stop name on same line', () => {
  // A line with two stops normalising to the same name (unusual but guard against it)
  const LINE_DUP = makeLine('dup', [
    makeStop('d1', 'Duplicate Station', 0.1),
    makeStop('d2', 'Duplicate Station', 0.2), // same name, different id/cx
    makeStop('ri2', 'Richmond Station', 0.10),
  ]);
  const LINE_OTHER = makeLine('other', [
    makeStop('ri3', 'Richmond Station', 0.10),
  ]);

  it('a line with two stops of the same name counts it only once for grouping', () => {
    // 'duplicate' should NOT be in sharedNames (only LINE_DUP has it)
    const { sharedNames } = computeSharedStopLayout([LINE_DUP, LINE_OTHER], VP_ALL, STRIP_HEIGHT, Y_OFFSET);
    expect(sharedNames.has('duplicate')).toBe(false);
    // 'richmond' IS shared
    expect(sharedNames.has('richmond')).toBe(true);
  });
});
