import type { LineDefinition } from '@takemethere/shared';
import type { Viewport } from './viewport.js';

function normName(n: string): string {
  return n.replace(/ Station$/, '').toLowerCase().trim();
}

/**
 * When a viewport is active, only show lines that have at least one stop
 * whose name is on the focus line AND whose canonicalX is within the window.
 * This prevents unrelated lines from appearing just because their stops happen
 * to land at the same canonicalX range as the viewed area.
 */
export function filterLinesByViewport(
  lines: LineDefinition[],
  viewport: Viewport,
  focusStopNames: Set<string>,
): LineDefinition[] {
  const lo = viewport.center - viewport.windowHalf;
  const hi = viewport.center + viewport.windowHalf;
  return lines.filter(l =>
    l.stops.some(s =>
      s.canonicalX >= lo && s.canonicalX <= hi && focusStopNames.has(normName(s.stopName)),
    ),
  );
}
