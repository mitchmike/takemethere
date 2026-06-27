import type { LineDefinition, LivePosition } from '@takemethere/shared';
import { useUiStore } from '../../store/uiStore.js';
import { useLinesStore } from '../../store/linesStore.js';
import { TrainDot } from './TrainDot.js';
import { VERT_STRIP_WIDTH, VERT_SVG_HEIGHT } from './LineMap.js';

/** Returns true (outbound) / false (inbound) / null (unknown) from GTFS direction_id. */
function movingForward(p: LivePosition): boolean | null {
  if (p.directionId === 0) return true;
  if (p.directionId === 1) return false;
  return null;
}

const LEFT_MARGIN = 120;
const RIGHT_PADDING = 24;
const DOT_RADIUS = 4;
const MIN_LABEL_GAP_PX = 45;

// Vertical mode layout constants
const VERT_TOP_MARGIN = 44;
const VERT_BOTTOM_PADDING = 20;
const VERT_MIN_LABEL_GAP_PX = 28; // matches horizontal MIN_LABEL_GAP feel
const VERT_LABEL_FONT = 11;        // matches horizontal font size

interface Props {
  line: LineDefinition;
  trains: LivePosition[];
  orientation: 'horizontal' | 'vertical';
  svgWidth: number;
  svgHeight: number;
  stripIndex: number;
  stripHeight: number;
}

export function LineStrip({ line, trains, orientation, svgWidth, svgHeight, stripIndex, stripHeight }: Props) {
  const selectedStopName = useUiStore(s => s.selectedStopName);
  const selectStop       = useUiStore(s => s.actions.selectStop);
  const directionFilter  = useLinesStore(s => s.directionFilter);

  const visibleTrains = trains.filter(t => {
    if (directionFilter === 'both') return true;
    const dir = movingForward(t);
    if (dir === null) return true; // unknown direction → show in both filters
    return directionFilter === 'outbound' ? dir : !dir;
  });

  const stops = line.stops;
  if (stops.length === 0) return null;

  if (orientation === 'vertical') {
    const stripX = stripIndex * VERT_STRIP_WIDTH + VERT_STRIP_WIDTH / 2;
    const usableHeight = svgHeight - VERT_TOP_MARGIN - VERT_BOTTOM_PADDING;
    const scaleY = (cx: number) => VERT_TOP_MARGIN + cx * usableHeight;

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
        <text
          x={stripX}
          y={VERT_TOP_MARGIN - 10}
          fill={line.color}
          fontSize={11}
          fontWeight={700}
          textAnchor="middle"
          dominantBaseline="auto"
        >
          {line.name}
        </text>

        <line
          x1={stripX} y1={y1}
          x2={stripX} y2={y2}
          stroke={line.color}
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Stop circles — below trains */}
        {stops.map((stop, i) => {
          const cy = scaleY(stop.canonicalX);
          const isSelected = selectedStopName === stop.stopName;
          const hasSelection = selectedStopName !== null;
          const dimmed = hasSelection && !isSelected;
          return (
            <circle
              key={stop.stopId}
              cx={stripX} cy={cy}
              r={DOT_RADIUS}
              fill={isSelected ? '#f59e0b' : '#fff'}
              stroke={isSelected ? '#f59e0b' : line.color}
              strokeWidth={2}
              opacity={dimmed ? 0.2 : 1}
              onClick={() => selectStop(isSelected ? null : stop.stopName)}
              style={{ cursor: 'pointer' }}
            />
          );
        })}

        {/* Trains — above stop circles */}
        {visibleTrains.map(train => (
          <TrainDot
            key={train.tripId}
            position={train}
            orientation="vertical"
            scaleX={scaleY}
            stripY={stripX}
            lineColor={line.color}
            movingForward={movingForward(train)}
          />
        ))}

        {/* Labels — topmost layer */}
        {stops.map((stop, i) => {
          if (!showLabel[i]) return null;
          const cy = scaleY(stop.canonicalX);
          const isSelected = selectedStopName === stop.stopName;
          const hasSelection = selectedStopName !== null;
          const dimmed = hasSelection && !isSelected;
          const label = stop.stopName.replace(/ Station$/, '');
          return (
            <text
              key={stop.stopId}
              x={stripX + DOT_RADIUS + 5}
              y={cy}
              fill={isSelected ? '#f59e0b' : '#52525b'}
              fontSize={VERT_LABEL_FONT}
              fontWeight={isSelected ? 600 : 400}
              dominantBaseline="middle"
              opacity={dimmed ? 0.2 : 1}
              onClick={() => selectStop(isSelected ? null : stop.stopName)}
              style={{ cursor: 'pointer' }}
            >
              {label}
            </text>
          );
        })}
      </g>
    );
  }

  // Horizontal mode
  const usableWidth = svgWidth - LEFT_MARGIN - RIGHT_PADDING;
  const lineY = stripIndex * stripHeight + stripHeight * 0.78;
  const scaleX = (cx: number) => LEFT_MARGIN + cx * usableWidth;

  const x1 = scaleX(stops[0].canonicalX);
  const x2 = scaleX(stops[stops.length - 1].canonicalX);

  let lastLabelX = -999;
  const showLabel = stops.map(stop => {
    const cx = scaleX(stop.canonicalX);
    if (cx - lastLabelX >= MIN_LABEL_GAP_PX) { lastLabelX = cx; return true; }
    return false;
  });

  return (
    <g>
      <text
        x={LEFT_MARGIN - 10}
        y={lineY + 1}
        fill={line.color}
        fontSize={11}
        fontWeight={600}
        textAnchor="end"
        dominantBaseline="middle"
      >
        {line.name}
      </text>

      <line
        x1={x1} y1={lineY}
        x2={x2} y2={lineY}
        stroke={line.color}
        strokeWidth={2.5}
        strokeLinecap="round"
      />

      {/* Stop circles — below trains */}
      {stops.map((stop) => {
        const cx = scaleX(stop.canonicalX);
        const isSelected = selectedStopName === stop.stopName;
        const hasSelection = selectedStopName !== null;
        const dimmed = hasSelection && !isSelected;
        return (
          <circle
            key={stop.stopId}
            cx={cx} cy={lineY}
            r={DOT_RADIUS}
            fill={isSelected ? '#f59e0b' : '#fff'}
            stroke={isSelected ? '#f59e0b' : line.color}
            strokeWidth={2}
            opacity={dimmed ? 0.2 : 1}
            onClick={() => selectStop(isSelected ? null : stop.stopName)}
            style={{ cursor: 'pointer' }}
          />
        );
      })}

      {/* Trains — above stop circles */}
      {visibleTrains.map(train => (
        <TrainDot
          key={train.tripId}
          position={train}
          orientation="horizontal"
          scaleX={scaleX}
          stripY={lineY}
          lineColor={line.color}
          movingForward={movingForward(train)}
        />
      ))}

      {/* Labels — topmost layer */}
      {stops.map((stop, i) => {
        if (!showLabel[i]) return null;
        const cx = scaleX(stop.canonicalX);
        const isSelected = selectedStopName === stop.stopName;
        const hasSelection = selectedStopName !== null;
        const dimmed = hasSelection && !isSelected;
        const label = stop.stopName.replace(/ Station$/, '');
        return (
          <text
            key={stop.stopId}
            transform={`rotate(-48, ${cx}, ${lineY})`}
            x={cx + 2}
            y={lineY - 7}
            fill={isSelected ? '#f59e0b' : '#52525b'}
            fontSize={11}
            fontWeight={isSelected ? 600 : 400}
            opacity={dimmed ? 0.2 : 1}
            onClick={() => selectStop(isSelected ? null : stop.stopName)}
            style={{ cursor: 'pointer' }}
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}
