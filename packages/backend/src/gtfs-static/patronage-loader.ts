import type { Pool } from 'pg';
import { parseCsv, normaliseStopName, computeDwellStats, type GapStats } from './patronage.js';

const PATRONAGE_CSV_URL =
  'https://opendata.transport.vic.gov.au/dataset/2fa2cdfa-84f1-455e-b6c9-058b92774b34/resource/c9507eb5-aa48-4a43-aa09-c10a24d1f2fe/download/annual_metropolitan_train_station_entries_fy_2024_2025.csv';

// Peak: AM 07:00–09:00 and PM 16:00–18:30 (seconds from midnight)
const PEAK_RANGES = [
  [7 * 3600, 9 * 3600],
  [16 * 3600, 18.5 * 3600],
] as const;

function isPeak(arrivalSec: number): boolean {
  return PEAK_RANGES.some(([lo, hi]) => arrivalSec >= lo && arrivalSec < hi);
}

function isOffpeak(arrivalSec: number): boolean {
  // 10:00–15:30
  return arrivalSec >= 10 * 3600 && arrivalSec < 15.5 * 3600;
}

/**
 * Download the CSV, match stops, compute dwell stats, and upsert to DB.
 * Emits progress strings for the admin UI.
 */
export async function loadPatronageData(
  pool: Pool,
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress('Downloading patronage CSV…');
  const res = await fetch(PATRONAGE_CSV_URL);
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status} ${res.statusText}`);
  const csv = await res.text();

  onProgress('Parsing CSV…');
  const stations = parseCsv(csv);
  onProgress(`Parsed ${stations.length} stations from CSV`);

  // Build lookup: normalised name → CSV row (CSV Stop_ID differs from our stop_id)
  const csvByName = new Map(stations.map(s => [normaliseStopName(s.stopName), s]));

  // Load all metro stops from DB
  onProgress('Matching CSV stations to DB stops…');
  const { rows: dbStops } = await pool.query<{
    stop_id: string; stop_name: string;
  }>(`SELECT stop_id, stop_name FROM stops`);

  // Match by normalised name; CSV uses PTV's own stop IDs (not always matching ours)
  const matched: Array<{
    dbStopId: string;
    csvRow: ReturnType<typeof parseCsv>[number];
  }> = [];
  for (const dbStop of dbStops) {
    const key = normaliseStopName(dbStop.stop_name);
    const csvRow = csvByName.get(key);
    if (csvRow) matched.push({ dbStopId: dbStop.stop_id, csvRow });
  }
  onProgress(`Matched ${matched.length} / ${dbStops.length} DB stops to patronage data`);

  // Upsert station_patronage
  for (const { dbStopId, csvRow } of matched) {
    await pool.query(
      `INSERT INTO station_patronage
         (stop_id, stop_name, pax_annual, pax_weekday, pax_norm_weekday,
          pax_am_peak, pax_interpeak, pax_pm_peak, pax_saturday, pax_sunday, data_year, loaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (stop_id) DO UPDATE SET
         stop_name=EXCLUDED.stop_name, pax_annual=EXCLUDED.pax_annual,
         pax_weekday=EXCLUDED.pax_weekday, pax_norm_weekday=EXCLUDED.pax_norm_weekday,
         pax_am_peak=EXCLUDED.pax_am_peak, pax_interpeak=EXCLUDED.pax_interpeak,
         pax_pm_peak=EXCLUDED.pax_pm_peak, pax_saturday=EXCLUDED.pax_saturday,
         pax_sunday=EXCLUDED.pax_sunday, data_year=EXCLUDED.data_year, loaded_at=NOW()`,
      [
        dbStopId, csvRow.stopName, csvRow.paxAnnual, csvRow.paxWeekday, csvRow.paxNormWeekday,
        csvRow.paxAmPeak, csvRow.paxInterpeak, csvRow.paxPmPeak,
        csvRow.paxSaturday, csvRow.paxSunday, csvRow.dataYear,
      ],
    );
  }

  // Compute dwell stats per line
  onProgress('Computing dwell stats per line…');

  const { rows: lineStops } = await pool.query<{ line_id: string; stop_id: string }>(
    `SELECT r.line_id, lso.stop_id
     FROM line_station_order lso
     JOIN routes r ON r.line_id = lso.line_id
     WHERE r.route_type = 400
     GROUP BY r.line_id, lso.stop_id`,
  );

  // lines per stop
  const linesByStop = new Map<string, Set<string>>();
  for (const row of lineStops) {
    if (!linesByStop.has(row.stop_id)) linesByStop.set(row.stop_id, new Set());
    linesByStop.get(row.stop_id)!.add(row.line_id);
  }
  const linesPerStop = new Map([...linesByStop.entries()].map(([k, v]) => [k, v.size]));

  // Stops grouped by line
  const stopsByLine = new Map<string, string[]>();
  for (const row of lineStops) {
    if (!stopsByLine.has(row.line_id)) stopsByLine.set(row.line_id, []);
    stopsByLine.get(row.line_id)!.push(row.stop_id);
  }

  // Patronage rows indexed by dbStopId
  const patronageByStopId = new Map(matched.map(({ dbStopId, csvRow }) => [
    dbStopId, {
      stopId: dbStopId, stopName: csvRow.stopName,
      paxAnnual: csvRow.paxAnnual, paxAmPeak: csvRow.paxAmPeak,
      paxInterpeak: csvRow.paxInterpeak, paxPmPeak: csvRow.paxPmPeak,
    },
  ]));

  // Schedule gap stats per stop per line: avg arrival-to-next-arrival in peak vs offpeak
  onProgress('Analysing schedule gaps for peak/off-peak dwell…');
  const gapStats = await computeGapStats(pool, stopsByLine);

  let totalUpserted = 0;
  for (const [lineId, stopIds] of stopsByLine) {
    const lineGaps = new Map(
      stopIds.map(sid => [sid, gapStats.get(`${lineId}:${sid}`) ?? { stopId: sid, peakGapSec: null, offpeakGapSec: null }]),
    );
    const results = computeDwellStats(stopIds, patronageByStopId, linesPerStop, lineGaps);

    for (const r of results) {
      await pool.query(
        `INSERT INTO stop_dwell_stats
           (stop_id, line_id, lines_at_stop, per_line_pax_annual, busyness_score,
            base_dwell_sec, peak_dwell_sec, offpeak_dwell_sec, peak_gap_sec, offpeak_gap_sec, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (stop_id, line_id) DO UPDATE SET
           lines_at_stop=EXCLUDED.lines_at_stop, per_line_pax_annual=EXCLUDED.per_line_pax_annual,
           busyness_score=EXCLUDED.busyness_score, base_dwell_sec=EXCLUDED.base_dwell_sec,
           peak_dwell_sec=EXCLUDED.peak_dwell_sec, offpeak_dwell_sec=EXCLUDED.offpeak_dwell_sec,
           peak_gap_sec=EXCLUDED.peak_gap_sec, offpeak_gap_sec=EXCLUDED.offpeak_gap_sec,
           computed_at=NOW()`,
        [
          r.stopId, lineId, r.linesAtStop, r.perLinePaxAnnual || null,
          r.busynessScore, r.baseDwellSec, r.peakDwellSec, r.offpeakDwellSec,
          lineGaps.get(r.stopId)?.peakGapSec ?? null,
          lineGaps.get(r.stopId)?.offpeakGapSec ?? null,
        ],
      );
      totalUpserted++;
    }
  }

  onProgress(`Upserted dwell stats for ${totalUpserted} stop×line combinations`);
}

/**
 * For each stop on each line, compute avg arrival-to-next-arrival gap in peak and offpeak.
 * Returns a map keyed by `${lineId}:${stopId}`.
 */
async function computeGapStats(
  pool: Pool,
  stopsByLine: Map<string, string[]>,
): Promise<Map<string, GapStats>> {
  // Query stop_times for all metro trips grouped by line, to derive gap stats
  const { rows } = await pool.query<{
    line_id: string;
    stop_id: string;
    arrival_time: number;
    next_arrival_time: number;
  }>(
    `SELECT r.line_id, st.stop_id,
            st.arrival_time,
            LEAD(st.arrival_time) OVER (PARTITION BY st.trip_id ORDER BY st.stop_sequence) AS next_arrival_time
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     WHERE r.route_type = 400
       AND st.arrival_time IS NOT NULL`,
  );

  // Accumulate peak and offpeak gaps per (lineId, stopId)
  type Acc = { peakSum: number; peakN: number; offpeakSum: number; offpeakN: number };
  const acc = new Map<string, Acc>();

  for (const row of rows) {
    if (row.next_arrival_time == null) continue;
    const gap = row.next_arrival_time - row.arrival_time;
    if (gap <= 0 || gap > 600) continue; // skip unreasonable gaps (>10 min between stops)

    const key = `${row.line_id}:${row.stop_id}`;
    if (!acc.has(key)) acc.set(key, { peakSum: 0, peakN: 0, offpeakSum: 0, offpeakN: 0 });
    const a = acc.get(key)!;

    if (isPeak(row.arrival_time)) {
      a.peakSum += gap; a.peakN++;
    } else if (isOffpeak(row.arrival_time)) {
      a.offpeakSum += gap; a.offpeakN++;
    }
  }

  const result = new Map<string, GapStats>();
  for (const [key, a] of acc) {
    const [, stopId] = key.split(':');
    result.set(key, {
      stopId,
      peakGapSec:    a.peakN    > 0 ? a.peakSum    / a.peakN    : null,
      offpeakGapSec: a.offpeakN > 0 ? a.offpeakSum / a.offpeakN : null,
    });
  }
  return result;
}

/**
 * Load dwell stats from DB into memory. Called on startup and after patronage reload.
 * Returns map: stopId → { lineId, baseDwellSec, peakDwellSec, offpeakDwellSec }
 */
export async function loadDwellStatsFromDb(
  pool: Pool,
): Promise<Map<string, Map<string, { baseDwellSec: number; peakDwellSec: number; offpeakDwellSec: number }>>> {
  const { rows } = await pool.query<{
    stop_id: string; line_id: string;
    base_dwell_sec: number; peak_dwell_sec: number; offpeak_dwell_sec: number;
  }>(`SELECT stop_id, line_id, base_dwell_sec, peak_dwell_sec, offpeak_dwell_sec FROM stop_dwell_stats`);

  // Outer key: stopId, inner key: lineId
  const result = new Map<string, Map<string, { baseDwellSec: number; peakDwellSec: number; offpeakDwellSec: number }>>();
  for (const row of rows) {
    if (!result.has(row.stop_id)) result.set(row.stop_id, new Map());
    result.get(row.stop_id)!.set(row.line_id, {
      baseDwellSec: row.base_dwell_sec,
      peakDwellSec: row.peak_dwell_sec,
      offpeakDwellSec: row.offpeak_dwell_sec,
    });
  }
  return result;
}
