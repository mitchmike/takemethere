import type { LineDefinition } from '@takemethere/shared';
import type { Viewport } from './viewport.js';

export const SHARE_FACTOR = 0.6;

function normName(n: string): string {
  return n.replace(/ Station$/, '').toLowerCase().trim();
}

export interface SharedStopLayout {
  /**
   * Per-line, per-normalised-stop-name y position.
   * Only contains entries for stops that this specific line actually shares with
   * at least one other visible line within the viewport.
   * Lines that don't share a given stop have no entry for it (use their own lineY).
   */
  sharedYs: Map<string, Map<string, number>>;
  /**
   * All normalised stop names shared by 2+ visible lines within the viewport.
   * Used to suppress per-line labels (LineMap renders them once at the shared cx).
   */
  sharedNames: Set<string>;
}

/**
 * Compute per-stop shared y-positions for line convergence in the zoomed view.
 *
 * For each stop that appears on 2+ visible lines within the viewport window, we
 * pull those lines' y positions toward their GROUP midpoint (average of just the
 * participating lines, not all visible lines). This ensures:
 *   - A stop shared by 3 of 4 lines converges to the midpoint of those 3.
 *   - Lines that don't share that specific stop are never pulled toward it.
 *   - The y ordering of participating lines is always preserved (no crossings).
 *
 * @param visibleLines  Lines in render order (index = strip index).
 * @param viewport      The active viewport window.
 * @param stripHeight   Height in px of each strip.
 * @param yOffset       Distance from strip top to the rail line in px.
 * @param shareFactor   How far to pull toward the group midpoint (0 = no pull, 1 = fully merged).
 */
export function computeSharedStopLayout(
  visibleLines: LineDefinition[],
  viewport: Viewport,
  stripHeight: number,
  yOffset: number,
  shareFactor = SHARE_FACTOR,
): SharedStopLayout {
  if (visibleLines.length < 2 || viewport.windowHalf <= 0) {
    return { sharedYs: new Map(), sharedNames: new Set() };
  }

  const lo = viewport.center - viewport.windowHalf;
  const hi = viewport.center + viewport.windowHalf;

  // For each normalised stop name, collect which strip indices contain it within the viewport.
  // Use a per-line `seen` guard so a line with two stops of the same name only counts once.
  const stopGroups = new Map<string, number[]>();
  for (let i = 0; i < visibleLines.length; i++) {
    const seenOnThisLine = new Set<string>();
    for (const stop of visibleLines[i].stops) {
      if (stop.canonicalX < lo || stop.canonicalX > hi) continue;
      const n = normName(stop.stopName);
      if (seenOnThisLine.has(n)) continue;
      seenOnThisLine.add(n);
      if (!stopGroups.has(n)) stopGroups.set(n, []);
      stopGroups.get(n)!.push(i);
    }
  }

  const sharedNames = new Set<string>();
  const sharedYs = new Map<string, Map<string, number>>();

  for (const [n, indices] of stopGroups) {
    if (indices.length < 2) continue;
    sharedNames.add(n);

    // Group midpoint = average lineY of the participating strips only.
    const lineYs = indices.map(i => i * stripHeight + yOffset);
    const groupMidY = lineYs.reduce((sum, y) => sum + y, 0) / lineYs.length;

    for (let k = 0; k < indices.length; k++) {
      const lineId = visibleLines[indices[k]].lineId;
      const myY    = lineYs[k];
      const targetY = myY + shareFactor * (groupMidY - myY);

      let lineMap = sharedYs.get(lineId);
      if (!lineMap) { lineMap = new Map(); sharedYs.set(lineId, lineMap); }
      lineMap.set(n, targetY);
    }
  }

  return { sharedYs, sharedNames };
}
