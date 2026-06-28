-- Raw per-station annual patronage from PTV open data
-- Source: annual_metropolitan_train_station_entries_fy_2024_2025.csv
-- Matched to our stops table by normalised stop name
CREATE TABLE IF NOT EXISTS station_patronage (
  stop_id              TEXT PRIMARY KEY REFERENCES stops(stop_id) ON DELETE CASCADE,
  stop_name            TEXT NOT NULL,
  pax_annual           INTEGER,
  pax_weekday          INTEGER,   -- avg daily weekday (all types)
  pax_norm_weekday     INTEGER,   -- normal weekday (excl. school hols)
  pax_am_peak          INTEGER,   -- avg daily AM peak boardings
  pax_interpeak        INTEGER,
  pax_pm_peak          INTEGER,
  pax_saturday         INTEGER,
  pax_sunday           INTEGER,
  data_year            TEXT NOT NULL,
  loaded_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Computed dwell statistics per stop × line.
-- Busyness is per-line (patronage / lines_at_stop) to avoid over-weighting city-loop stops.
-- Dwell estimates are recomputed whenever patronage data or GTFS is reloaded.
CREATE TABLE IF NOT EXISTS stop_dwell_stats (
  stop_id              TEXT NOT NULL REFERENCES stops(stop_id) ON DELETE CASCADE,
  line_id              TEXT NOT NULL,
  lines_at_stop        INTEGER NOT NULL DEFAULT 1,
  per_line_pax_annual  INTEGER,
  busyness_score       FLOAT NOT NULL DEFAULT 0,   -- log-normalised 0→1 across all stops on this line
  base_dwell_sec       FLOAT NOT NULL DEFAULT 20,  -- 20s (quiet) → 60s (busy)
  peak_dwell_sec       FLOAT NOT NULL DEFAULT 20,  -- base + 90% of peak schedule gap excess
  offpeak_dwell_sec    FLOAT NOT NULL DEFAULT 20,  -- same as base for off-peak
  peak_gap_sec         FLOAT,   -- avg arrival→next-arrival gap for peak trips (for transparency)
  offpeak_gap_sec      FLOAT,   -- avg arrival→next-arrival gap for off-peak trips
  computed_at          TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (stop_id, line_id)
);

CREATE INDEX IF NOT EXISTS stop_dwell_stats_line_idx ON stop_dwell_stats (line_id);
