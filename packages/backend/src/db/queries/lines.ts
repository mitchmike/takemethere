import { pool } from '../client.js';
import { computeAlignedPositions } from '@takemethere/shared';
import { LINE_MAP } from '@takemethere/shared';
import type { LineDefinition } from '@takemethere/shared';

export async function getLines(): Promise<LineDefinition[]> {
  const { rows } = await pool.query<{
    line_id: string;
    stop_id: string;
    stop_name: string;
    canonical_position: number;
    stop_lat: number;
    stop_lon: number;
  }>(`
    SELECT lso.line_id, lso.stop_id, lso.stop_name, lso.canonical_position,
           s.stop_lat, s.stop_lon
    FROM line_station_order lso
    JOIN stops s ON s.stop_id = lso.stop_id
    ORDER BY lso.line_id, lso.canonical_position
  `);

  const sequences = rows.filter(r => r.line_id && LINE_MAP.has(r.line_id)).map(r => ({
    lineId: r.line_id,
    stopId: r.stop_id,
    stopName: r.stop_name,
    canonicalPosition: r.canonical_position,
  }));

  const aligned = computeAlignedPositions(sequences);

  // Build lat/lon lookup by stopId
  const coords = new Map(rows.map(r => [r.stop_id, { stopLat: r.stop_lat, stopLon: r.stop_lon }]));

  return aligned.map(({ lineId, stations }) => {
    const cfg = LINE_MAP.get(lineId);
    return {
      lineId,
      name: cfg?.name ?? lineId,
      color: cfg?.color ?? '#888888',
      stops: stations.map(s => ({
        lineId,
        stopId: s.stopId,
        stopName: s.stopName,
        canonicalPosition: s.canonicalPosition ?? 0,
        canonicalX: s.canonicalX,
        stopLat: coords.get(s.stopId)?.stopLat ?? 0,
        stopLon: coords.get(s.stopId)?.stopLon ?? 0,
      })),
    };
  });
}
