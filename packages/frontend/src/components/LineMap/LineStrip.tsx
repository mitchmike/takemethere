import type { LineDefinition, LivePosition } from '@takemethere/shared';
import { useUiStore } from '../../store/uiStore.js';
import { TrainDot } from './TrainDot.js';

const STRIP_HEIGHT = 60;
const LABEL_OFFSET = 18;
const DOT_RADIUS = 5;

interface Props {
  line: LineDefinition;
  trains: LivePosition[];
  orientation: 'horizontal' | 'vertical';
  svgWidth: number;
  stripIndex: number;
}

export function LineStrip({ line, trains, orientation, svgWidth, stripIndex }: Props) {
  const selectedStopId = useUiStore(s => s.selectedStopId);
  const selectStop = useUiStore(s => s.actions.selectStop);

  const padding = 40;
  const usableWidth = svgWidth - padding * 2;
  const scaleX = (cx: number) => padding + cx * usableWidth;

  const stripY = stripIndex * STRIP_HEIGHT + STRIP_HEIGHT / 2;

  return (
    <g>
      {/* Line name */}
      <text
        x={orientation === 'horizontal' ? 4 : stripY}
        y={orientation === 'horizontal' ? stripY + 4 : 12}
        fill={line.color}
        fontSize={11}
        fontWeight="600"
      >
        {line.name}
      </text>

      {/* Rail line */}
      {orientation === 'horizontal' ? (
        <line
          x1={scaleX(0)} y1={stripY}
          x2={scaleX(1)} y2={stripY}
          stroke={line.color}
          strokeWidth={2}
          opacity={0.6}
        />
      ) : (
        <line
          x1={stripY} y1={scaleX(0)}
          x2={stripY} y2={scaleX(1)}
          stroke={line.color}
          strokeWidth={2}
          opacity={0.6}
        />
      )}

      {/* Station dots */}
      {line.stops.map(stop => {
        const cx = scaleX(stop.canonicalX);
        const isSelected = selectedStopId === stop.stopId;
        const hasSelection = selectedStopId !== null;

        const dotX = orientation === 'horizontal' ? cx : stripY;
        const dotY = orientation === 'horizontal' ? stripY : cx;
        const labelX = orientation === 'horizontal' ? cx : stripY + DOT_RADIUS + 4;
        const labelY = orientation === 'horizontal' ? stripY - DOT_RADIUS - 4 : cx + 4;

        return (
          <g
            key={stop.stopId}
            onClick={() => selectStop(isSelected ? null : stop.stopId)}
            style={{ cursor: 'pointer' }}
          >
            <circle
              cx={dotX}
              cy={dotY}
              r={DOT_RADIUS}
              fill={isSelected ? '#ffcc00' : line.color}
              opacity={hasSelection && !isSelected ? 0.2 : 1}
            />
            <text
              x={labelX}
              y={labelY}
              fill={isSelected ? '#ffcc00' : '#ccc'}
              fontSize={9}
              textAnchor={orientation === 'horizontal' ? 'middle' : 'start'}
              opacity={hasSelection && !isSelected ? 0.2 : 1}
            >
              {stop.stopName}
            </text>
          </g>
        );
      })}

      {/* Train dots */}
      {trains.map(train => (
        <TrainDot
          key={train.tripId}
          position={train}
          stops={line.stops}
          orientation={orientation}
          scaleX={scaleX}
          stripY={stripY}
        />
      ))}
    </g>
  );
}
