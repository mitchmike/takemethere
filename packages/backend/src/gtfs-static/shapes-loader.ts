import type { Pool } from 'pg';
import { MELBOURNE_LINES } from '@takemethere/shared';

const GEOJSON_URL =
  'https://opendata.transport.vic.gov.au/dataset/6d36dfd9-8693-4552-8a03-05eb29a391fd/resource/a9836237-2647-462b-ad76-bd24d71d8598/download/public_transport_lines.geojson';

// Valid lineIds for quick membership check
const VALID_LINE_IDS = new Set(MELBOURNE_LINES.map(l => l.lineId));

interface GeoJsonFeature {
  properties: {
    MODE: string;
    LONG_NAME: string;
    SHORT_NAME: string | null;
    HEADSIGN: string | null;
    SHAPE_ID: string;
  };
  geometry: {
    type: string;
    coordinates: [number, number][];
  };
}

/**
 * Converts a GeoJSON LONG_NAME like "Glen Waverley - City" to our lineId "glen-waverley".
 * Returns null if not a recognised metro line.
 */
export function longNameToLineId(longName: string): string | null {
  // Strip everything from " - " onwards (handles "X - City", "X - Frankston", etc.)
  const terminus = longName.split(' - ')[0].trim();
  const lineId = terminus.toLowerCase().replace(/\s+/g, '-');
  return VALID_LINE_IDS.has(lineId) ? lineId : null;
}

/**
 * From a list of features for one LONG_NAME, select the canonical shape:
 * 1. Prefer shapes whose headsign contains "Flinders Street" (full terminus→city run)
 * 2. Among the preferred set (or all if none qualify), pick the one with the most coordinates.
 *
 * Returns null if the feature list is empty.
 */
export function selectCanonicalShape(features: GeoJsonFeature[]): GeoJsonFeature | null {
  if (features.length === 0) return null;

  const preferred = features.filter(f =>
    f.properties.HEADSIGN?.includes('Flinders Street')
  );
  const pool = preferred.length > 0 ? preferred : features;
  return pool.reduce((best, f) =>
    f.geometry.coordinates.length > best.geometry.coordinates.length ? f : best
  );
}

/**
 * Download the PTV lines GeoJSON, select one canonical shape per metro line,
 * and upsert into line_shapes as PostGIS LineString geometry.
 */
export async function loadLineShapes(
  pool: Pool,
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress('Downloading PTV lines GeoJSON…');
  const res = await fetch(GEOJSON_URL);
  if (!res.ok) throw new Error(`GeoJSON fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as { features: GeoJsonFeature[] };

  onProgress(`Loaded ${data.features.length} features. Filtering metro lines…`);

  // Filter to metro train, exclude replacement buses
  const metro = data.features.filter(f =>
    f.properties.MODE === 'METRO TRAIN' &&
    !f.properties.LONG_NAME.toLowerCase().includes('replacement') &&
    !f.properties.SHORT_NAME?.toLowerCase().includes('bus') &&
    f.geometry.type === 'LineString' &&
    f.geometry.coordinates.length > 0
  );
  onProgress(`${metro.length} metro features after filtering`);

  // Group by LONG_NAME
  const byName = new Map<string, GeoJsonFeature[]>();
  for (const f of metro) {
    const name = f.properties.LONG_NAME;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(f);
  }

  let loaded = 0;
  let skipped = 0;
  for (const [longName, features] of byName) {
    const lineId = longNameToLineId(longName);
    if (!lineId) { skipped++; continue; }

    const canonical = selectCanonicalShape(features);
    if (!canonical) { skipped++; continue; }

    const coords = canonical.geometry.coordinates;
    // Build GeoJSON LineString for ST_GeomFromGeoJSON
    const geojson = JSON.stringify({ type: 'LineString', coordinates: coords });

    await pool.query(
      `INSERT INTO line_shapes (line_id, shape, coord_count, source_headsign, loaded_at)
       VALUES ($1, ST_GeomFromGeoJSON($2), $3, $4, NOW())
       ON CONFLICT (line_id) DO UPDATE SET
         shape = EXCLUDED.shape,
         coord_count = EXCLUDED.coord_count,
         source_headsign = EXCLUDED.source_headsign,
         loaded_at = NOW()`,
      [lineId, geojson, coords.length, canonical.properties.HEADSIGN],
    );
    loaded++;
    onProgress(`  Loaded ${lineId} (${coords.length} coords, headsign: ${canonical.properties.HEADSIGN ?? '—'})`);
  }

  onProgress(`Done. Loaded ${loaded} line shapes, skipped ${skipped} unrecognised names.`);
}
