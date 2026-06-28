export interface Viewport {
  center: number;
  windowHalf: number;
}

const STOPS_EITHER_SIDE = 3;
const MIN_WINDOW_HALF = 0.02;
const MAX_WINDOW_HALF = 0.65;

export function computeTrainViewport(
  trainCx: number,
  stops: { canonicalX: number }[],
): Viewport {
  if (!stops.length) return { center: trainCx, windowHalf: 0.1 };
  const sorted = [...stops].sort((a, b) => a.canonicalX - b.canonicalX);
  let nearestIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const d = Math.abs(sorted[i].canonicalX - trainCx);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }
  const leftStop  = sorted[Math.max(0, nearestIdx - STOPS_EITHER_SIDE)];
  const rightStop = sorted[Math.min(sorted.length - 1, nearestIdx + STOPS_EITHER_SIDE)];
  // Centre the window between the boundary stops (not on the train) so both sides
  // always show the same number of stops rather than one side dominating.
  const lo = leftStop.canonicalX;
  const hi = rightStop.canonicalX;
  const center     = (lo + hi) / 2;
  const windowHalf = (hi - lo) / 2 * 1.1;
  return clampViewport({ center, windowHalf });
}

export function computeStationViewport(
  stationCx: number,
  stops: { canonicalX: number }[],
): Viewport {
  const base = computeTrainViewport(stationCx, stops);
  return clampViewport({ center: stationCx, windowHalf: base.windowHalf * 2.0 });
}

export function adjustZoomViewport(viewport: Viewport, factor: number): Viewport {
  return clampViewport({ ...viewport, windowHalf: viewport.windowHalf * factor });
}

function clampViewport(v: Viewport): Viewport {
  return { ...v, windowHalf: Math.max(MIN_WINDOW_HALF, Math.min(MAX_WINDOW_HALF, v.windowHalf)) };
}
