export interface StationSequence {
  lineId: string;
  stopId: string;
  stopName: string;
  canonicalPosition: number;
}

export interface AlignedStation {
  stopId: string;
  stopName: string;
  canonicalX: number;
}

export interface AlignedLine {
  lineId: string;
  stations: AlignedStation[];
}

/**
 * Given per-line station sequences (from the line_station_order DB view),
 * compute a shared horizontal coordinate (canonicalX ∈ [0,1]) for each stop
 * such that stops shared across lines land at the same X position.
 *
 * Algorithm:
 * 1. Pick reference line (most stops)
 * 2. Assign reference line integer positions 0..N
 * 3. For each other line, use shared stops as anchors and interpolate between them
 * 4. Normalise all positions to [0,1]
 */
export function computeAlignedPositions(
  sequences: StationSequence[],
): AlignedLine[] {
  // Group by lineId preserving canonical order
  const byLine = new Map<string, StationSequence[]>();
  for (const s of sequences) {
    if (!byLine.has(s.lineId)) byLine.set(s.lineId, []);
    byLine.get(s.lineId)!.push(s);
  }
  for (const stops of byLine.values()) {
    stops.sort((a, b) => a.canonicalPosition - b.canonicalPosition);
  }

  // Pick reference line (most stops)
  let refLineId = '';
  let maxStops = 0;
  for (const [lineId, stops] of byLine) {
    if (stops.length > maxStops) { maxStops = stops.length; refLineId = lineId; }
  }

  // Assign reference positions
  const refStops = byLine.get(refLineId)!;
  const refPositions = new Map<string, number>();
  refStops.forEach((s, i) => refPositions.set(s.stopId, i));

  // Build raw positions for every line
  const rawPositions = new Map<string, Map<string, number>>();

  for (const [lineId, stops] of byLine) {
    const positions = new Map<string, number>();

    if (lineId === refLineId) {
      stops.forEach((s, i) => positions.set(s.stopId, i));
    } else {
      // Find anchors: stops that appear in the reference line
      const anchors: Array<{ idx: number; stopId: string; refPos: number }> = [];
      stops.forEach((s, idx) => {
        if (refPositions.has(s.stopId)) {
          anchors.push({ idx, stopId: s.stopId, refPos: refPositions.get(s.stopId)! });
        }
      });

      if (anchors.length === 0) {
        // No shared stops: assign sequential positions offset from 0
        stops.forEach((s, i) => positions.set(s.stopId, i));
      } else {
        // Interpolate between anchors
        // Segment before first anchor
        const first = anchors[0];
        for (let i = 0; i < first.idx; i++) {
          const offset = i - first.idx;
          positions.set(stops[i].stopId, first.refPos + offset);
        }

        // Segments between consecutive anchors
        for (let a = 0; a < anchors.length - 1; a++) {
          const lo = anchors[a];
          const hi = anchors[a + 1];
          positions.set(lo.stopId, lo.refPos);
          const gap = hi.idx - lo.idx;
          for (let i = lo.idx + 1; i < hi.idx; i++) {
            const t = (i - lo.idx) / gap;
            positions.set(stops[i].stopId, lo.refPos + t * (hi.refPos - lo.refPos));
          }
        }

        // Segment after last anchor
        const last = anchors[anchors.length - 1];
        positions.set(last.stopId, last.refPos);
        for (let i = last.idx + 1; i < stops.length; i++) {
          positions.set(stops[i].stopId, last.refPos + (i - last.idx));
        }
      }
    }

    rawPositions.set(lineId, positions);
  }

  // Normalise to [0, 1] across all positions globally
  let globalMin = Infinity;
  let globalMax = -Infinity;
  for (const positions of rawPositions.values()) {
    for (const pos of positions.values()) {
      if (pos < globalMin) globalMin = pos;
      if (pos > globalMax) globalMax = pos;
    }
  }
  const range = globalMax - globalMin || 1;

  // Assemble output
  const result: AlignedLine[] = [];
  for (const [lineId, stops] of byLine) {
    const positions = rawPositions.get(lineId)!;
    result.push({
      lineId,
      stations: stops.map(s => ({
        stopId: s.stopId,
        stopName: s.stopName,
        canonicalX: (positions.get(s.stopId)! - globalMin) / range,
      })),
    });
  }

  return result;
}
