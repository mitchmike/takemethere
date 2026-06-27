import { useMemo } from 'react';
import { useLinesStore } from '../../store/linesStore.js';
import { useTrainsStore } from '../../store/trainsStore.js';
import { useLineRoom } from '../../socket/hooks.js';
import { useDeadReckoning } from '../../hooks/useDeadReckoning.js';
import { LineFilter } from './LineFilter.js';
import { DirectionFilter } from './DirectionFilter.js';
import { LineStrip } from './LineStrip.js';

const STRIP_HEIGHT = 60;
const SVG_WIDTH = 1200;

export function LineMap() {
  const lines = useLinesStore(s => s.lines);
  const selectedLineIds = useLinesStore(s => s.selectedLineIds);
  const orientation = useLinesStore(s => s.orientation);
  const positions = useTrainsStore(s => s.positions);

  const visibleLines = useMemo(
    () => lines.filter(l => selectedLineIds.has(l.lineId)),
    [lines, selectedLineIds],
  );

  const selectedLineIdArray = useMemo(
    () => Array.from(selectedLineIds),
    [selectedLineIds],
  );

  useLineRoom(selectedLineIdArray);
  useDeadReckoning();

  const svgHeight = visibleLines.length * STRIP_HEIGHT + 20;

  return (
    <div>
      <LineFilter />
      <DirectionFilter />
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={SVG_WIDTH}
          height={svgHeight}
          style={{ display: 'block' }}
        >
          {visibleLines.map((line, i) => {
            const lineTrains = Array.from(positions.values()).filter(
              p => p.lineId === line.lineId,
            );
            return (
              <LineStrip
                key={line.lineId}
                line={line}
                trains={lineTrains}
                orientation={orientation}
                svgWidth={SVG_WIDTH}
                stripIndex={i}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
