import { useRef, useState, useEffect, useMemo } from 'react';
import { useLinesStore } from '../../store/linesStore.js';
import { useTrainsStore } from '../../store/trainsStore.js';
import { useLineRoom } from '../../socket/hooks.js';
import { useDeadReckoning } from '../../hooks/useDeadReckoning.js';
import { REGION_ORDER, LINE_MAP } from '@takemethere/shared';
import { LineFilter } from './LineFilter.js';
import { DirectionFilter } from './DirectionFilter.js';
import { LineStrip } from './LineStrip.js';

export const STRIP_HEIGHT = 100;
export const VERT_STRIP_WIDTH = 120;  // wider to fit 11px labels without clipping
export const VERT_SVG_HEIGHT = 700;   // more height = more stop spacing

export function LineMap() {
  const lines = useLinesStore(s => s.lines);
  const selectedLineIds = useLinesStore(s => s.selectedLineIds);
  const orientation = useLinesStore(s => s.orientation);
  const positions = useTrainsStore(s => s.positions);

  const containerRef = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth] = useState(1200);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSvgWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sort visible lines by region order
  const visibleLines = useMemo(() => {
    const selected = lines.filter(l => selectedLineIds.has(l.lineId));
    return selected.sort((a, b) => {
      const ra = REGION_ORDER.indexOf(LINE_MAP.get(a.lineId)?.region as any);
      const rb = REGION_ORDER.indexOf(LINE_MAP.get(b.lineId)?.region as any);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
  }, [lines, selectedLineIds]);

  const selectedLineIdArray = useMemo(() => Array.from(selectedLineIds), [selectedLineIds]);
  useLineRoom(selectedLineIdArray);
  useDeadReckoning();

  const isVertical = orientation === 'vertical';
  const computedSvgWidth = isVertical ? visibleLines.length * VERT_STRIP_WIDTH + 8 : svgWidth;
  const computedSvgHeight = isVertical ? VERT_SVG_HEIGHT : visibleLines.length * STRIP_HEIGHT + 24;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        background: '#fff',
        border: '1px solid #e4e4e7',
        borderRadius: '10px',
        padding: '14px 18px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex',
        gap: '24px',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}>
        <LineFilter />
        <div style={{ marginLeft: 'auto' }}>
          <DirectionFilter />
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          background: '#fff',
          border: '1px solid #e4e4e7',
          borderRadius: '10px',
          padding: '8px 0 8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          overflowX: isVertical ? 'auto' : 'visible',
        }}
      >
        <svg
          width={computedSvgWidth}
          height={computedSvgHeight}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {visibleLines.map((line, i) => {
            const lineTrains = Array.from(positions.values()).filter(p => p.lineId === line.lineId);
            return (
              <LineStrip
                key={line.lineId}
                line={line}
                trains={lineTrains}
                orientation={orientation}
                svgWidth={computedSvgWidth}
                svgHeight={computedSvgHeight}
                stripIndex={i}
                stripHeight={STRIP_HEIGHT}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
