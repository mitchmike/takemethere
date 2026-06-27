export interface StopCoord {
  stopId: string;
  canonicalX: number;
  lat: number;
  lon: number;
}

/**
 * Projects a GPS point onto a polyline defined by ordered stop coordinates.
 * Returns the canonicalX value [0,1] of the closest point on the polyline.
 * Returns -1 if the stops array is empty.
 *
 * Uses planar (Euclidean) distance in lat/lon space — adequate for metro-scale
 * distances (~50km) where the error is <0.1%.
 */
export function projectToLine(lat: number, lon: number, stops: StopCoord[]): number {
  if (stops.length === 0) return -1;
  if (stops.length === 1) return stops[0].canonicalX;

  let bestDist = Infinity;
  let bestCx = stops[0].canonicalX;

  for (let i = 0; i < stops.length - 1; i++) {
    const ax = stops[i].lon,  ay = stops[i].lat;
    const bx = stops[i + 1].lon, by = stops[i + 1].lat;

    const abx = bx - ax, aby = by - ay;
    const apx = lon - ax, apy = lat - ay;
    const ab2 = abx * abx + aby * aby;

    // Clamp projection parameter t to [0,1]
    const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2)) : 0;

    const nearX = ax + t * abx;
    const nearY = ay + t * aby;
    const d = (lon - nearX) ** 2 + (lat - nearY) ** 2;

    if (d < bestDist) {
      bestDist = d;
      bestCx = stops[i].canonicalX + t * (stops[i + 1].canonicalX - stops[i].canonicalX);
    }
  }

  return bestCx;
}
