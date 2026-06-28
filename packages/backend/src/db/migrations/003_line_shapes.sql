-- Canonical line shapes from PTV GeoJSON (one polyline per metro line).
-- Stored as PostGIS LineString for snapping and distance queries.
CREATE TABLE IF NOT EXISTS line_shapes (
  line_id       TEXT PRIMARY KEY,
  shape         GEOMETRY(LineString, 4326) NOT NULL,
  coord_count   INTEGER NOT NULL,
  source_headsign TEXT,
  loaded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS line_shapes_geom_idx ON line_shapes USING GIST (shape);

-- Tracks the last time each data entity was successfully loaded.
-- frequency: 'startup'|'daily'|'weekly'|'monthly'|'manual'
-- Auto-refresh logic in freshness.ts checks this on backend startup.
CREATE TABLE IF NOT EXISTS data_freshness (
  entity        TEXT PRIMARY KEY,
  last_loaded_at TIMESTAMPTZ,
  refresh_frequency TEXT NOT NULL DEFAULT 'manual',
  label         TEXT NOT NULL,
  description   TEXT
);

-- Seed the known entities with their configured frequencies.
-- The frequency column here is authoritative — app code reads it at startup.
INSERT INTO data_freshness (entity, refresh_frequency, label, description) VALUES
  ('gtfs_static', 'manual',  'GTFS Static',       'Routes, stops, trips, timetables'),
  ('line_shapes',  'monthly', 'Line Shapes',        'PTV GeoJSON polylines for map rendering'),
  ('patronage',    'monthly', 'Station Patronage',  'Annual boarding counts for dwell estimation')
ON CONFLICT (entity) DO UPDATE SET
  label       = EXCLUDED.label,
  description = EXCLUDED.description;
