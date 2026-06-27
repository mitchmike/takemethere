export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Compute dead-reckoned fraction (0–1) between two stops.
 * Uses scheduled segment duration and elapsed time since last GTFS-RT update.
 */
export function deadReckonFraction(
  lastGtfsFraction: number,
  lastGtfsTimestampMs: number,
  scheduledDepartureEpochMs: number,
  scheduledArrivalEpochMs: number,
  nowMs: number,
): number {
  const scheduledDuration = scheduledArrivalEpochMs - scheduledDepartureEpochMs;
  if (scheduledDuration <= 0) return lastGtfsFraction;

  const elapsed = nowMs - lastGtfsTimestampMs;
  const advance = elapsed / scheduledDuration;
  return clamp(lastGtfsFraction + advance, 0, 1);
}

/**
 * Smoothly reconcile animated fraction toward ground truth over a given duration.
 * Call each frame with increasing elapsedMs until elapsedMs >= reconcileDurationMs.
 */
export function reconcileFraction(
  animatedFraction: number,
  truthFraction: number,
  elapsedMs: number,
  reconcileDurationMs: number,
): number {
  const t = clamp(elapsedMs / reconcileDurationMs, 0, 1);
  return lerp(animatedFraction, truthFraction, t);
}
