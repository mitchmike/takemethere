import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useLinesStore } from '../../store/linesStore.js';
import { useTrainsStore } from '../../store/trainsStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { useLineRoom } from '../../socket/hooks.js';
import { useDeadReckoning } from '../../hooks/useDeadReckoning.js';
import { REGION_ORDER, LINE_MAP } from '@takemethere/shared';
import { LineFilter } from './LineFilter.js';
import { DirectionFilter } from './DirectionFilter.js';
import { LineStrip } from './LineStrip.js';
import { TrainInfoPanel } from './TrainInfoPanel.js';
import { FeedStatus } from './FeedStatus.js';
import { computeTrainViewport, computeStationViewport } from './viewport.js';

export const STRIP_HEIGHT            = 100;
export const STRIP_HEIGHT_WITH_TIMES = 155;
export const VERT_STRIP_WIDTH        = 120;
export const VERT_SVG_HEIGHT         = 700;

export function LineMap() {
  const lines           = useLinesStore(s => s.lines);
  const selectedLineIds = useLinesStore(s => s.selectedLineIds);
  const orientation     = useLinesStore(s => s.orientation);
  const positions       = useTrainsStore(s => s.positions);

  const selectedTripId   = useUiStore(s => s.selectedTripId);
  const selectedStopName = useUiStore(s => s.selectedStopName);
  const viewport         = useUiStore(s => s.viewport);
  const { setViewport, nudgeViewportCenter, adjustZoom } = useUiStore(s => s.actions);

  const containerRef     = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth] = useState(1200);
  // Track the GPS timestamp of the last re-center to avoid recentering on the same poll
  const prevTimestampRef = useRef<number>(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSvgWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Set initial viewport when a train is selected
  useEffect(() => {
    if (!selectedTripId) { setViewport(null); return; }
    const pos  = positions.get(selectedTripId);
    if (!pos) return;
    const line = lines.find(l => l.lineId === pos.lineId);
    if (!line) return;
    prevTimestampRef.current = pos.timestamp;
    setViewport(computeTrainViewport(pos.canonicalX, line.stops));
  // Intentionally only fires when selectedTripId changes, not on every position update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTripId]);

  // Re-centre on GPS poll for the selected train (timestamp changes every ~30s)
  useEffect(() => {
    if (!selectedTripId) return;
    const pos = positions.get(selectedTripId);
    if (!pos || pos.timestamp === prevTimestampRef.current) return;
    prevTimestampRef.current = pos.timestamp;
    nudgeViewportCenter(pos.canonicalX);
  }, [selectedTripId, positions, nudgeViewportCenter]);

  // Set viewport when a station is selected
  useEffect(() => {
    if (!selectedStopName) { setViewport(null); return; }
    for (const line of lines) {
      const stop = line.stops.find(s => s.stopName === selectedStopName);
      if (stop) { setViewport(computeStationViewport(stop.canonicalX, line.stops)); return; }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStopName]);

  // Scroll wheel zooms in/out when a viewport is active
  const handleWheel = useCallback((e: WheelEvent) => {
    if (!viewport) return;
    e.preventDefault();
    adjustZoom(e.deltaY > 0 ? 1.25 : 0.8);
  }, [viewport, adjustZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Filter visible lines: when zoomed, only show lines with a stop inside the viewport window
  const visibleLines = useMemo(() => {
    let selected = lines.filter(l => selectedLineIds.has(l.lineId));
    if (viewport) {
      const lo = viewport.center - viewport.windowHalf;
      const hi = viewport.center + viewport.windowHalf;
      selected = selected.filter(l => l.stops.some(s => s.canonicalX >= lo && s.canonicalX <= hi));
    }
    return selected.sort((a, b) => {
      const ra = REGION_ORDER.indexOf(LINE_MAP.get(a.lineId)?.region as any);
      const rb = REGION_ORDER.indexOf(LINE_MAP.get(b.lineId)?.region as any);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
  }, [lines, selectedLineIds, viewport]);

  // Stop names on the "focus" line (selected train's line or selected station's line).
  // Used to suppress stop times on neighbour-line stops that aren't shared.
  const focusStopNames = useMemo<Set<string> | null>(() => {
    const normName = (n: string) => n.replace(/ Station$/, '').toLowerCase().trim();
    if (selectedTripId) {
      const pos = positions.get(selectedTripId);
      if (pos) {
        const line = lines.find(l => l.lineId === pos.lineId);
        if (line) return new Set(line.stops.map(s => normName(s.stopName)));
      }
    }
    if (selectedStopName) {
      for (const line of lines) {
        if (line.stops.some(s => s.stopName === selectedStopName)) {
          return new Set(line.stops.map(s => normName(s.stopName)));
        }
      }
    }
    return null;
  }, [selectedTripId, selectedStopName, positions, lines]);

  const selectedLineIdArray = useMemo(() => Array.from(selectedLineIds), [selectedLineIds]);
  useLineRoom(selectedLineIdArray);
  useDeadReckoning();

  const isVertical  = orientation === 'vertical';
  const showTimes   = viewport !== null;
  const stripHeight = showTimes ? STRIP_HEIGHT_WITH_TIMES : STRIP_HEIGHT;

  const computedSvgWidth  = isVertical ? visibleLines.length * VERT_STRIP_WIDTH + 8 : svgWidth;
  const computedSvgHeight = isVertical ? VERT_SVG_HEIGHT : visibleLines.length * stripHeight + 24;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', position: 'relative' }}>
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
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <FeedStatus />
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
                allPositions={positions}
                orientation={orientation}
                svgWidth={computedSvgWidth}
                svgHeight={computedSvgHeight}
                stripIndex={i}
                stripHeight={stripHeight}
                viewport={viewport}
                selectedTripId={selectedTripId}
                showTimes={showTimes}
                focusStopNames={focusStopNames}
              />
            );
          })}
        </svg>
      </div>

      <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 100 }}>
        <TrainInfoPanel />
      </div>
    </div>
  );
}
