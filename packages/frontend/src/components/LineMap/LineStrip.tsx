import type { LineDefinition, LivePosition } from '@takemethere/shared';
import { useUiStore } from '../../store/uiStore.js';
import { useLinesStore } from '../../store/linesStore.js';
import { TrainDot } from './TrainDot.js';
import { VERT_STRIP_WIDTH, VERT_SVG_HEIGHT } from './LineMap.js';
import type { Viewport } from './viewport.js';
import { getArrivalsForStop } from './arrivals.js';

function movingForward(p: LivePosition): boolean | null {
  if (p.directionId === 0) return true;
  if (p.directionId === 1) return false;
  return null;
}

export const LEFT_MARGIN       = 120;
export const RIGHT_PADDING     = 24;
const DOT_RADIUS        = 4;
const MIN_LABEL_GAP_PX  = 45;
const TIMES_Y_OFFSET    = 18; // px below the line stroke where times begin
const TIMES_ROW_H       = 14; // px per arrival row

const VERT_TOP_MARGIN       = 44;
const VERT_BOTTOM_PADDING   = 20;
const VERT_MIN_LABEL_GAP_PX = 28;
const VERT_LABEL_FONT       = 11;

function melbTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatDelta(secs: number): string {
  if (Math.abs(secs) < 15) return '';
  const s = Math.abs(Math.round(secs));
  return secs > 0 ? `(+${s}s)` : `(-${s}s)`;
}

interface Props {
  line: LineDefinition;
  trains: LivePosition[];
  allPositions: Map<string, LivePosition>;
  orientation: 'horizontal' | 'vertical';
  svgWidth: number;
  svgHeight: number;
  stripIndex: number;
  stripHeight: number;
  viewport: Viewport | null;
  selectedTripId: string | null;
  showTimes: boolean;
  /** Normalised stop names on the focus line — only show times at stops in this set */
  focusStopNames: Set<string> | null;
  /** Normalised stop names shared across 2+ visible lines — suppress per-line label (LineMap renders it once) */
  sharedStopNames: Set<string> | null;
  /** Whether this strip is the focus line (selected train's line) — bypasses focusStopNames filter for times */
  isFocusLine: boolean;
  /** Y for shared stops on THIS strip when zoomed — closer to mid-y but still distinct (null = use lineY) */
  sharedStopY: number | null;
}

function normStopName(name: string): string {
  return name.replace(/ Station$/, '').toLowerCase().trim();
}

export function LineStrip({
  line, trains, allPositions, orientation, svgWidth, svgHeight,
  stripIndex, stripHeight, viewport, selectedTripId, showTimes, focusStopNames, sharedStopNames,
  isFocusLine, sharedStopY,
}: Props) {
  const selectedStopName = useUiStore(s => s.selectedStopName);
  const selectStop       = useUiStore(s => s.actions.selectStop);
  const directionFilter  = useLinesStore(s => s.directionFilter);

  const visibleTrains = trains.filter(t => {
    if (directionFilter === 'both') return true;
    const dir = movingForward(t);
    if (dir === null) return true;
    return directionFilter === 'outbound' ? dir : !dir;
  });

  const stops = line.stops;
  if (stops.length === 0) return null;

  const nowSec = Date.now() / 1000;

  // ── Vertical mode ─────────────────────────────────────────────────────────
  if (orientation === 'vertical') {
    const stripX      = stripIndex * VERT_STRIP_WIDTH + VERT_STRIP_WIDTH / 2;
    const usableHeight = svgHeight - VERT_TOP_MARGIN - VERT_BOTTOM_PADDING;
    const scaleY       = (cx: number) => VERT_TOP_MARGIN + cx * usableHeight;

    const y1 = scaleY(stops[0].canonicalX);
    const y2 = scaleY(stops[stops.length - 1].canonicalX);

    let lastLabelY = -999;
    const showLabel = stops.map(stop => {
      const cy = scaleY(stop.canonicalX);
      if (cy - lastLabelY >= VERT_MIN_LABEL_GAP_PX) { lastLabelY = cy; return true; }
      return false;
    });

    return (
      <g>
        <text x={stripX} y={VERT_TOP_MARGIN - 10} fill={line.color} fontSize={11} fontWeight={700}
          textAnchor="middle" dominantBaseline="auto">
          {line.name}
        </text>
        <line x1={stripX} y1={y1} x2={stripX} y2={y2} stroke={line.color} strokeWidth={2.5} strokeLinecap="round" />
        {stops.map(stop => {
          const cy = scaleY(stop.canonicalX);
          const isSelected = selectedStopName === stop.stopName;
          const dimmed     = selectedStopName !== null && !isSelected;
          return (
            <circle key={stop.stopId} cx={stripX} cy={cy} r={DOT_RADIUS}
              fill={isSelected ? '#f59e0b' : '#fff'} stroke={isSelected ? '#f59e0b' : line.color}
              strokeWidth={2} opacity={dimmed ? 0.2 : 1}
              onClick={() => selectStop(isSelected ? null : stop.stopName)}
              style={{ cursor: 'pointer' }}
            />
          );
        })}
        {visibleTrains.map(train => (
          <TrainDot key={train.tripId} position={train} orientation="vertical"
            scaleX={scaleY} stripY={stripX} lineColor={line.color} movingForward={movingForward(train)} />
        ))}
        {stops.map((stop, i) => {
          if (!showLabel[i]) return null;
          const cy = scaleY(stop.canonicalX);
          const isSelected = selectedStopName === stop.stopName;
          const dimmed     = selectedStopName !== null && !isSelected;
          return (
            <text key={stop.stopId} x={stripX + DOT_RADIUS + 5} y={cy}
              fill={isSelected ? '#f59e0b' : '#52525b'} fontSize={VERT_LABEL_FONT}
              fontWeight={isSelected ? 600 : 400} dominantBaseline="middle"
              opacity={dimmed ? 0.2 : 1}
              onClick={() => selectStop(isSelected ? null : stop.stopName)}
              style={{ cursor: 'pointer' }}>
              {stop.stopName.replace(/ Station$/, '')}
            </text>
          );
        })}
      </g>
    );
  }

  // ── Horizontal mode ───────────────────────────────────────────────────────

  const usableWidth = svgWidth - LEFT_MARGIN - RIGHT_PADDING;

  // When showing times the line sits higher in the strip to leave room below.
  const lineY = stripIndex * stripHeight + (showTimes ? 65 : Math.round(stripHeight * 0.78));

  // Viewport-aware canonicalX → pixel mapping.
  // Default [0,1] keeps all lines on the same scale so shared stops align.
  // When zoomed, map the viewport window across the full usable width.
  const viewMin = viewport ? viewport.center - viewport.windowHalf : 0;
  const viewMax = viewport ? viewport.center + viewport.windowHalf : 1;
  const scaleX  = (cx: number) =>
    LEFT_MARGIN + ((cx - viewMin) / (viewMax - viewMin)) * usableWidth;

  const isInView = (cx: number) =>
    !viewport || (cx >= viewMin && cx <= viewMax);

  // Clip line stroke: when zoomed, clamp to the line's actual stop extent within the window
  const lineMinCx = stops[0].canonicalX;
  const lineMaxCx = stops[stops.length - 1].canonicalX;
  const x1 = scaleX(Math.max(lineMinCx, viewMin));
  const x2 = scaleX(Math.min(lineMaxCx, viewMax));

  // stopY: shared stops move to this strip's closer-to-centre y when zoomed; non-shared stay at lineY.
  const stopY = (name: string): number => {
    if (sharedStopY !== null && sharedStopNames?.has(normStopName(name))) return sharedStopY;
    return lineY;
  };

  let lastLabelX = -999;
  const showLabel = stops.map(stop => {
    if (!isInView(stop.canonicalX)) return false;
    // Shared stops are rendered by LineMap — skip them entirely so they don't consume spacing
    if (sharedStopNames?.has(normStopName(stop.stopName))) return false;
    const cx = scaleX(stop.canonicalX);
    if (cx - lastLabelX >= MIN_LABEL_GAP_PX) { lastLabelX = cx; return true; }
    return false;
  });

  // Build stepped polyline for the rail.
  // Edges are always at lineY so the step happens exactly AT the shared stop's x — not before it.
  // Segments are horizontal or vertical only (no diagonals).
  const railPoints = (() => {
    const visible = stops
      .filter(s => isInView(s.canonicalX))
      .map(s => ({ x: scaleX(s.canonicalX), y: stopY(s.stopName) }));

    const all = [
      { x: x1, y: lineY },
      ...visible,
      { x: x2, y: lineY },
    ];

    const pts: string[] = [`${all[0].x},${all[0].y}`];
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const curr = all[i];
      if (prev.y !== curr.y) pts.push(`${curr.x},${prev.y}`);
      pts.push(`${curr.x},${curr.y}`);
    }
    return pts.join(' ');
  })();

  return (
    <g>
      {/* Line name */}
      <text x={LEFT_MARGIN - 10} y={lineY + 1} fill={line.color} fontSize={11} fontWeight={600}
        textAnchor="end" dominantBaseline="middle">
        {line.name}
      </text>

      {/* Line stroke — polyline so shared stops can converge vertically when zoomed */}
      <polyline points={railPoints}
        stroke={line.color} strokeWidth={2.5} strokeLinecap="round" fill="none" />

      {/* Stop circles */}
      {stops.map(stop => {
        if (!isInView(stop.canonicalX)) return null;
        const cx         = scaleX(stop.canonicalX);
        const isSelected = selectedStopName === stop.stopName;
        const dimmed     = selectedStopName !== null && !isSelected;
        return (
          <circle key={stop.stopId} cx={cx} cy={stopY(stop.stopName)} r={DOT_RADIUS}
            fill={isSelected ? '#f59e0b' : '#fff'}
            stroke={isSelected ? '#f59e0b' : line.color}
            strokeWidth={2} opacity={dimmed ? 0.2 : 1}
            onClick={() => selectStop(isSelected ? null : stop.stopName)}
            style={{ cursor: 'pointer' }}
          />
        );
      })}

      {/* Trains — y follows the rail segment the train is on (prev stop's y) */}
      {visibleTrains.map(train => (
        <TrainDot key={train.tripId} position={train} orientation="horizontal"
          scaleX={scaleX} stripY={stopY(train.prevStopName)} lineColor={line.color} movingForward={movingForward(train)} />
      ))}

      {/* Station labels — larger when zoomed; suppressed for shared stops (LineMap renders once) */}
      {stops.map((stop, i) => {
        if (!showLabel[i]) return null;
        if (sharedStopNames?.has(normStopName(stop.stopName))) return null;
        const cx         = scaleX(stop.canonicalX);
        const isSelected = selectedStopName === stop.stopName;
        const dimmed     = selectedStopName !== null && !isSelected;
        const labelSize  = viewport ? 13 : 11;
        return (
          <text key={stop.stopId}
            transform={`rotate(-48, ${cx}, ${lineY})`}
            x={cx + 2} y={lineY - 7}
            fill={isSelected ? '#f59e0b' : '#52525b'}
            fontSize={labelSize} fontWeight={isSelected ? 600 : 400}
            opacity={dimmed ? 0.2 : 1}
            onClick={() => selectStop(isSelected ? null : stop.stopName)}
            style={{ cursor: 'pointer' }}>
            {stop.stopName.replace(/ Station$/, '')}
          </text>
        );
      })}

      {/* Stop times — only rendered when viewport is active and stop is on the focus line */}
      {showTimes && stops.map(stop => {
        if (!isInView(stop.canonicalX)) return null;
        // Always show times on the focus line; on other lines, filter to stops shared with the focus line
        if (!isFocusLine && focusStopNames && !focusStopNames.has(normStopName(stop.stopName))) return null;
        const cx       = scaleX(stop.canonicalX);
        const arrivals = getArrivalsForStop(
          stop.stopId, stop.stopName, allPositions,
          line.lineId, directionFilter, nowSec,
        );
        if (!arrivals.length) return null;

        return (
          <g key={`times-${stop.stopId}`}>
            {arrivals.map((arr, i) => {
              const isSelTrain  = arr.tripId === selectedTripId;
              const dirArrow    = arr.directionId === 0 ? '→' : arr.directionId === 1 ? '←' : '';
              const schedStr    = melbTime(arr.adjustedArrivalEpoch);
              const delta       = arr.predictedArrivalEpoch > 0
                ? arr.predictedArrivalEpoch - arr.adjustedArrivalEpoch
                : 0;
              const deltaStr    = formatDelta(delta);
              const y           = lineY + TIMES_Y_OFFSET + i * TIMES_ROW_H;
              const mainColor   = isSelTrain ? line.color : '#71717a';
              return (
                <text key={arr.tripId} x={cx} y={y}
                  textAnchor="middle" fontSize={11}
                  fontWeight={isSelTrain ? 700 : 400}>
                  <tspan fill={mainColor}>{dirArrow} {schedStr}</tspan>
                  {deltaStr && (
                    <tspan fill={delta > 0 ? '#f59e0b' : '#22c55e'} fontSize={9}> GPS{deltaStr}</tspan>
                  )}
                </text>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
