CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS routes (
  route_id         TEXT PRIMARY KEY,
  route_short_name TEXT NOT NULL,
  route_long_name  TEXT NOT NULL,
  route_type       SMALLINT NOT NULL,
  route_color      TEXT,
  line_id          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stops (
  stop_id       TEXT PRIMARY KEY,
  stop_name     TEXT NOT NULL,
  stop_lat      DOUBLE PRECISION NOT NULL,
  stop_lon      DOUBLE PRECISION NOT NULL,
  location_geom GEOMETRY(Point, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326)
  ) STORED
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id       TEXT PRIMARY KEY,
  route_id      TEXT NOT NULL REFERENCES routes(route_id),
  service_id    TEXT NOT NULL,
  trip_headsign TEXT,
  direction_id  SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stop_times (
  trip_id        TEXT NOT NULL REFERENCES trips(trip_id),
  stop_sequence  INTEGER NOT NULL,
  stop_id        TEXT NOT NULL REFERENCES stops(stop_id),
  arrival_time   INTEGER,   -- seconds since midnight (can exceed 86400 for overnight services)
  departure_time INTEGER,
  PRIMARY KEY (trip_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS stop_times_stop_id_idx ON stop_times (stop_id);
CREATE INDEX IF NOT EXISTS stop_times_trip_id_idx ON stop_times (trip_id);

CREATE TABLE IF NOT EXISTS shapes (
  shape_id          TEXT NOT NULL,
  shape_pt_lat      DOUBLE PRECISION NOT NULL,
  shape_pt_lon      DOUBLE PRECISION NOT NULL,
  shape_pt_sequence INTEGER NOT NULL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
);

CREATE MATERIALIZED VIEW IF NOT EXISTS line_station_order AS
WITH longest_trip AS (
  SELECT DISTINCT ON (r.line_id)
    r.line_id,
    t.trip_id
  FROM trips t
  JOIN routes r ON r.route_id = t.route_id
  WHERE r.route_type = 400
    AND t.direction_id = 0
  ORDER BY r.line_id, (
    SELECT COUNT(*) FROM stop_times st2
    JOIN stops s2 ON s2.stop_id = st2.stop_id
    WHERE st2.trip_id = t.trip_id
      AND s2.stop_name NOT LIKE '%Rail Replacement Bus Stop%'
  ) DESC
)
SELECT
  lt.line_id,
  MIN(st.stop_id) AS stop_id,
  s.stop_name,
  AVG(st.stop_sequence)::FLOAT AS avg_sequence,
  ROW_NUMBER() OVER (
    PARTITION BY lt.line_id
    ORDER BY AVG(st.stop_sequence)
  ) AS canonical_position
FROM longest_trip lt
JOIN stop_times st ON st.trip_id = lt.trip_id
JOIN stops s ON s.stop_id = st.stop_id
WHERE s.stop_name NOT LIKE '%Rail Replacement Bus Stop%'
GROUP BY lt.line_id, s.stop_name;

CREATE UNIQUE INDEX IF NOT EXISTS line_station_order_idx ON line_station_order (line_id, stop_id);
