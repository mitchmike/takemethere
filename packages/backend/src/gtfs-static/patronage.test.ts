import { describe, it, expect } from 'vitest';
import {
  normalisedBusyness,
  baseDwellSec,
  peakDwellSec,
  computeDwellStats,
  parseCsv,
  normaliseStopName,
  type PatronageRow,
  type GapStats,
} from './patronage.js';

// ─── normalisedBusyness ───────────────────────────────────────────────────────

describe('normalisedBusyness', () => {
  it('returns 0 for the minimum', () => {
    expect(normalisedBusyness(1000, 1000, 10000)).toBeCloseTo(0, 5);
  });

  it('returns 1 for the maximum', () => {
    expect(normalisedBusyness(10000, 1000, 10000)).toBeCloseTo(1, 5);
  });

  it('returns a value between 0 and 1 for a mid-range value', () => {
    const v = normalisedBusyness(3162, 1000, 10000); // geometric midpoint on log scale
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    expect(v).toBeCloseTo(0.5, 1);
  });

  it('returns 0 for zero pax', () => {
    expect(normalisedBusyness(0, 1000, 10000)).toBe(0);
  });

  it('returns 0 when min === max', () => {
    expect(normalisedBusyness(5000, 5000, 5000)).toBe(0);
  });
});

// ─── baseDwellSec ─────────────────────────────────────────────────────────────

describe('baseDwellSec', () => {
  it('returns 20s for busyness=0 (quiet station)', () => {
    expect(baseDwellSec(0)).toBe(20);
  });

  it('returns 60s for busyness=1 (maximum busyness)', () => {
    expect(baseDwellSec(1)).toBe(60);
  });

  it('returns 40s for busyness=0.5', () => {
    expect(baseDwellSec(0.5)).toBe(40);
  });
});

// ─── peakDwellSec ─────────────────────────────────────────────────────────────

describe('peakDwellSec', () => {
  it('returns base dwell when no gap data', () => {
    expect(peakDwellSec(30, null, null)).toBe(30);
  });

  it('returns base dwell when peak gap <= offpeak gap (no excess)', () => {
    expect(peakDwellSec(30, 120, 130)).toBe(30);
  });

  it('adds 90% of gap excess to base dwell', () => {
    // peak gap = 150s, offpeak gap = 120s → excess = 30s → 0.9 * 30 = 27s extra
    expect(peakDwellSec(30, 150, 120)).toBeCloseTo(57, 5);
  });

  it('scales correctly with larger excess', () => {
    // 60s excess → 0.9 * 60 = 54s extra → total = 20 + 54 = 74s
    expect(peakDwellSec(20, 180, 120)).toBeCloseTo(74, 5);
  });
});

// ─── computeDwellStats ────────────────────────────────────────────────────────

const PATRONAGE: Map<string, PatronageRow> = new Map([
  ['A', { stopId: 'A', stopName: 'Alpha', paxAnnual: 1_000_000, paxAmPeak: 5000, paxInterpeak: 3000, paxPmPeak: 6000 }],
  ['B', { stopId: 'B', stopName: 'Beta',  paxAnnual:   100_000, paxAmPeak:  500, paxInterpeak:  300, paxPmPeak:  600 }],
  ['C', { stopId: 'C', stopName: 'Gamma', paxAnnual:    10_000, paxAmPeak:   50, paxInterpeak:   30, paxPmPeak:   60 }],
]);

const LINES_PER_STOP: Map<string, number> = new Map([
  ['A', 5],  // shared by 5 lines
  ['B', 1],
  ['C', 1],
]);

const GAP_STATS: Map<string, GapStats> = new Map([
  ['A', { stopId: 'A', peakGapSec: 150, offpeakGapSec: 120 }],
  ['B', { stopId: 'B', peakGapSec: 130, offpeakGapSec: 120 }],
  ['C', { stopId: 'C', peakGapSec: null, offpeakGapSec: null }],
]);

describe('computeDwellStats', () => {
  const results = computeDwellStats(['A', 'B', 'C'], PATRONAGE, LINES_PER_STOP, GAP_STATS);

  it('returns one result per stop', () => {
    expect(results).toHaveLength(3);
  });

  it('divides patronage by lines_at_stop for per-line pax', () => {
    const a = results.find(r => r.stopId === 'A')!;
    expect(a.linesAtStop).toBe(5);
    expect(a.perLinePaxAnnual).toBe(200_000); // 1M / 5
  });

  it('normalises busyness so the highest per-line pax = 1', () => {
    // B has 100k/1 = 100k per line, A has 200k/5 = 200k per line — A is busier
    const a = results.find(r => r.stopId === 'A')!;
    const b = results.find(r => r.stopId === 'B')!;
    expect(a.busynessScore).toBeCloseTo(1, 5);
    expect(b.busynessScore).toBeGreaterThan(0);
    expect(b.busynessScore).toBeLessThan(1);
  });

  it('base dwell is 60s for busiest, ≥20s for quietest', () => {
    const a = results.find(r => r.stopId === 'A')!;
    const c = results.find(r => r.stopId === 'C')!;
    expect(a.baseDwellSec).toBeCloseTo(60, 1);
    expect(c.baseDwellSec).toBeGreaterThanOrEqual(20);
  });

  it('peak dwell exceeds base when peak gap > offpeak gap', () => {
    const a = results.find(r => r.stopId === 'A')!;
    expect(a.peakDwellSec).toBeGreaterThan(a.baseDwellSec);
    // excess = 30s, 90% = 27s extra
    expect(a.peakDwellSec).toBeCloseTo(a.baseDwellSec + 27, 1);
  });

  it('offpeak dwell equals base dwell', () => {
    const b = results.find(r => r.stopId === 'B')!;
    expect(b.offpeakDwellSec).toBeCloseTo(b.baseDwellSec, 5);
  });

  it('handles missing patronage data with default 20s dwell', () => {
    const results2 = computeDwellStats(['X'], new Map(), new Map(), new Map());
    const x = results2[0];
    expect(x.busynessScore).toBe(0);
    expect(x.baseDwellSec).toBe(20);
  });
});

// ─── parseCsv ─────────────────────────────────────────────────────────────────

const SAMPLE_CSV = `Fin_year,Stop_ID,Stop_name,Stop_lat,Stop_long,Pax_annual,Pax_weekday,Pax_norm_weekday,Pax_sch_hol_weekday,Pax_Saturday,Pax_Sunday,Pax_pre_AM_peak,Pax_AM_peak,Pax_interpeak,Pax_PM_peak,Pax_PM_late
FY24-25,19854,Flinders Street,-37.818,144.966,19633300,60900,61800,57400,43150,31350,1100,3600,12600,33650,10900
FY24-25,19869,Boronia,-37.860,145.284,462850,1500,1600,1300,800,550,200,800,350,200,50
FY24-25,19999,Bad Row,-37.0,145.0,not_a_number,0,0,0,0,0,0,0,0,0,0`;

describe('parseCsv', () => {
  const rows = parseCsv(SAMPLE_CSV);

  it('parses valid rows and skips invalid ones', () => {
    expect(rows).toHaveLength(2);
  });

  it('extracts stop id, name, and all patronage fields', () => {
    const f = rows.find(r => r.stopName === 'Flinders Street')!;
    expect(f.stopId).toBe('19854');
    expect(f.paxAnnual).toBe(19633300);
    expect(f.paxAmPeak).toBe(3600);
    expect(f.paxPmPeak).toBe(33650);
    expect(f.dataYear).toBe('FY24-25');
  });

  it('parses all numeric fields correctly for Boronia', () => {
    const b = rows.find(r => r.stopName === 'Boronia')!;
    expect(b.paxSaturday).toBe(800);
    expect(b.paxSunday).toBe(550);
  });
});

// ─── normaliseStopName ────────────────────────────────────────────────────────

describe('normaliseStopName', () => {
  it('strips trailing " Station"', () => {
    expect(normaliseStopName('Flinders Street Station')).toBe('flinders street');
  });

  it('is case-insensitive', () => {
    expect(normaliseStopName('BORONIA STATION')).toBe('boronia');
  });

  it('handles names without " Station" suffix', () => {
    expect(normaliseStopName('Flinders Street')).toBe('flinders street');
  });
});
