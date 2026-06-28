/**
 * Pure functions for computing station busyness scores and dwell estimates.
 * No I/O — all testable in isolation.
 */

export interface PatronageRow {
  stopId: string;
  stopName: string;
  paxAnnual: number;
  paxAmPeak: number;
  paxInterpeak: number;
  paxPmPeak: number;
}

export interface GapStats {
  stopId: string;
  peakGapSec: number | null;
  offpeakGapSec: number | null;
}

export interface DwellResult {
  stopId: string;
  linesAtStop: number;
  perLinePaxAnnual: number;
  busynessScore: number;   // 0→1 log-normalised
  baseDwellSec: number;    // 20–60s
  peakDwellSec: number;
  offpeakDwellSec: number;
}

const MIN_DWELL_SEC = 20;
const MAX_DWELL_SEC = 60;
const PEAK_DWELL_FRACTION = 0.9;  // 90% of peak schedule gap excess attributed to dwell

/**
 * Log-normalise patronage values to [0, 1].
 * Log scale prevents Flinders Street (20M pax) drowning out every other station.
 */
export function normalisedBusyness(perLinePax: number, minPax: number, maxPax: number): number {
  if (maxPax <= minPax || perLinePax <= 0) return 0;
  const logVal = Math.log(Math.max(1, perLinePax));
  const logMin = Math.log(Math.max(1, minPax));
  const logMax = Math.log(Math.max(1, maxPax));
  if (logMax <= logMin) return 0;
  return Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)));
}

export function baseDwellSec(busynessScore: number): number {
  return MIN_DWELL_SEC + (MAX_DWELL_SEC - MIN_DWELL_SEC) * busynessScore;
}

/**
 * Adjust base dwell for peak using schedule gap analysis.
 * "90% of the difference between peak and off-peak inter-station time is dwell."
 */
export function peakDwellSec(base: number, peakGapSec: number | null, offpeakGapSec: number | null): number {
  if (peakGapSec == null || offpeakGapSec == null) return base;
  const extraGap = peakGapSec - offpeakGapSec;
  if (extraGap <= 0) return base;
  return base + PEAK_DWELL_FRACTION * extraGap;
}

/**
 * Compute DwellResult for each stop given patronage rows, per-stop line counts,
 * and schedule-derived gap statistics.
 * Returns null for a stop if no patronage data is available (busynessScore=0, dwell=20s default).
 */
export function computeDwellStats(
  stopIds: string[],                         // all stop IDs on this line
  patronageByStopId: Map<string, PatronageRow>,
  linesPerStop: Map<string, number>,         // stopId → number of lines serving it
  gapStats: Map<string, GapStats>,          // stopId → peak/offpeak gap
): DwellResult[] {
  // Compute per-line pax for each stop to normalise
  const perLinePaxValues: number[] = [];
  const perLinePaxByStop = new Map<string, number>();

  for (const stopId of stopIds) {
    const row = patronageByStopId.get(stopId);
    if (!row) continue;
    const lines = linesPerStop.get(stopId) ?? 1;
    const pax = Math.round(row.paxAnnual / lines);
    perLinePaxByStop.set(stopId, pax);
    perLinePaxValues.push(pax);
  }

  const minPax = perLinePaxValues.length ? Math.min(...perLinePaxValues) : 1;
  const maxPax = perLinePaxValues.length ? Math.max(...perLinePaxValues) : 1;

  return stopIds.map(stopId => {
    const lines = linesPerStop.get(stopId) ?? 1;
    const perLinePax = perLinePaxByStop.get(stopId) ?? 0;
    const busyness = normalisedBusyness(perLinePax, minPax, maxPax);
    const base = baseDwellSec(busyness);
    const gap = gapStats.get(stopId);
    const peak = peakDwellSec(base, gap?.peakGapSec ?? null, gap?.offpeakGapSec ?? null);

    return {
      stopId,
      linesAtStop: lines,
      perLinePaxAnnual: perLinePax,
      busynessScore: busyness,
      baseDwellSec: base,
      peakDwellSec: peak,
      offpeakDwellSec: base,  // off-peak dwell = base (no adjustment)
    };
  });
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

export interface CsvStation {
  stopId: string;
  stopName: string;
  paxAnnual: number;
  paxWeekday: number;
  paxNormWeekday: number;
  paxAmPeak: number;
  paxInterpeak: number;
  paxPmPeak: number;
  paxSaturday: number;
  paxSunday: number;
  dataYear: string;
}

/**
 * Parse the PTV annual metropolitan train station entries CSV.
 * Columns: Fin_year,Stop_ID,Stop_name,Stop_lat,Stop_long,Pax_annual,Pax_weekday,
 *          Pax_norm_weekday,Pax_sch_hol_weekday,Pax_Saturday,Pax_Sunday,
 *          Pax_pre_AM_peak,Pax_AM_peak,Pax_interpeak,Pax_PM_peak,Pax_PM_late
 */
export function parseCsv(csv: string): CsvStation[] {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const [header, ...rows] = lines;
  const cols = header.split(',').map(c => c.trim());

  const idx = (name: string) => cols.indexOf(name);
  const finYearIdx   = idx('Fin_year');
  const stopIdIdx    = idx('Stop_ID');
  const stopNameIdx  = idx('Stop_name');
  const annualIdx    = idx('Pax_annual');
  const weekdayIdx   = idx('Pax_weekday');
  const normWdIdx    = idx('Pax_norm_weekday');
  const amPeakIdx    = idx('Pax_AM_peak');
  const interIdx     = idx('Pax_interpeak');
  const pmPeakIdx    = idx('Pax_PM_peak');
  const satIdx       = idx('Pax_Saturday');
  const sunIdx       = idx('Pax_Sunday');

  const result: CsvStation[] = [];
  for (const row of rows) {
    const c = row.split(',');
    if (c.length < cols.length) continue;
    const paxAnnual = parseInt(c[annualIdx], 10);
    if (isNaN(paxAnnual)) continue;
    result.push({
      stopId:        c[stopIdIdx]?.trim() ?? '',
      stopName:      c[stopNameIdx]?.trim() ?? '',
      paxAnnual,
      paxWeekday:    parseInt(c[weekdayIdx], 10) || 0,
      paxNormWeekday:parseInt(c[normWdIdx], 10)  || 0,
      paxAmPeak:     parseInt(c[amPeakIdx], 10)  || 0,
      paxInterpeak:  parseInt(c[interIdx], 10)   || 0,
      paxPmPeak:     parseInt(c[pmPeakIdx], 10)  || 0,
      paxSaturday:   parseInt(c[satIdx], 10)     || 0,
      paxSunday:     parseInt(c[sunIdx], 10)     || 0,
      dataYear:      c[finYearIdx]?.trim() ?? '',
    });
  }
  return result;
}

/**
 * Normalise a stop name for matching between the CSV (e.g. "Flinders Street")
 * and our DB (e.g. "Flinders Street Station").
 */
export function normaliseStopName(name: string): string {
  return name.toLowerCase().replace(/\s+station\s*$/i, '').trim();
}
