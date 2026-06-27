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
  }>(`
    SELECT line_id, stop_id, stop_name, canonical_position
    FROM line_station_order
    ORDER BY line_id, canonical_position
  `);

  const sequences = rows.map(r => ({
    lineId: r.line_id,
    stopId: r.stop_id,
    stopName: r.stop_name,
    canonicalPosition: r.canonical_position,
  }));

  const aligned = computeAlignedPositions(sequences);

  return aligned.map(({ lineId, stations }) => {
    const cfg = LINE_MAP.get(lineId);
    return {
      lineId,
      name: cfg?.name ?? lineId,
      color: cfg?.color ?? '#888888',
      stops: stations.map(s => ({ lineId, ...s, canonicalPosition: 0 })),
    };
  });
}
