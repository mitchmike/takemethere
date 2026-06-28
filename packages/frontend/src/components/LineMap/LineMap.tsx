import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useLinesStore } from '../../store/linesStore.js';
import { useTrainsStore } from '../../store/trainsStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { useLineRoom } from '../../socket/hooks.js';
import { useDeadReckoning } from '../../hooks/useDeadReckoning.js';
import { REGION_ORDER, LINE_MAP } from '@takemethere/shared';
import { LineFilter } from './LineFilter.js';
import { DirectionFilter } from './DirectionFilter.js';
import { LineStrip, LEFT_MARGIN, RIGHT_PADDING } from './LineStrip.js';
import { TrainInfoPanel } from './TrainInfoPanel.js';
import { FeedStatus } from './FeedStatus.js';
import { computeTrainViewport, computeStationViewport } from './viewport.js';
import { filterLinesByViewport } from './viewportFilter.js';

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

  // Stop names on the "focus" line (selected train's line or selected station's line).
  // Used to suppress stop times on neighbour-line stops that aren't shared.
  // MUST be declared before visibleLines (which reads it).
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

  // Filter visible lines: when zoomed, only show lines sharing a stop name with the focus line
  // that lands within the viewport. This prevents unrelated lines from appearing just because
  // their canonicalX range overlaps (e.g. Frankston near East Camberwell).
  const visibleLines = useMemo(() => {
    let selected = lines.filter(l => selectedLineIds.has(l.lineId));
    if (viewport && focusStopNames) {
      selected = filterLinesByViewport(selected, viewport, focusStopNames);
    }
    return selected.sort((a, b) => {
      const ra = REGION_ORDER.indexOf(LINE_MAP.get(a.lineId)?.region as any);
      const rb = REGION_ORDER.indexOf(LINE_MAP.get(b.lineId)?.region as any);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
  }, [lines, selectedLineIds, viewport, focusStopNames]);

  // Stop names that appear on 2+ visible lines within the viewport.
  // In the zoomed view these are rendered once as shared labels (not once per line strip).
  const sharedStopNames = useMemo<Set<string> | null>(() => {
    if (!viewport || visibleLines.length < 2) return null;
    const norm = (n: string) => n.replace(/ Station$/, '').toLowerCase().trim();
    const lo = viewport.center - viewport.windowHalf;
    const hi = viewport.center + viewport.windowHalf;
    const nameCounts = new Map<string, number>();
    for (const line of visibleLines) {
      for (const stop of line.stops) {
        if (stop.canonicalX < lo || stop.canonicalX > hi) continue;
        const n = norm(stop.stopName);
        nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
      }
    }
    const shared = new Set<string>();
    for (const [name, count] of nameCounts) { if (count >= 2) shared.add(name); }
    return shared.size > 0 ? shared : null;
  }, [viewport, visibleLines]);

  // lineId of the selected train, used to mark the focus strip so it always shows stop times
  const focusLineId = useMemo<string | null>(() => {
    if (selectedTripId) {
      const pos = positions.get(selectedTripId);
      if (pos) return pos.lineId;
    }
    return null;
  }, [selectedTripId, positions]);

  const selectedLineIdArray = useMemo(() => Array.from(selectedLineIds), [selectedLineIds]);
  useLineRoom(selectedLineIdArray);
  useDeadReckoning();

  const isVertical  = orientation === 'vertical';
  const showTimes   = viewport !== null;
  const stripHeight = showTimes ? STRIP_HEIGHT_WITH_TIMES : STRIP_HEIGHT;

  // Y coordinate where shared stops converge when zoomed (midpoint between first and last strip)
  const sharedStopMidY = useMemo<number | null>(() => {
    if (!viewport || visibleLines.length < 2) return null;
    const yOffset = showTimes ? 65 : Math.round(stripHeight * 0.78);
    return ((visibleLines.length - 1) * stripHeight) / 2 + yOffset;
  }, [viewport, visibleLines.length, stripHeight, showTimes]);

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
                sharedStopNames={sharedStopNames}
                isFocusLine={line.lineId === focusLineId}
                sharedStopMidY={sharedStopMidY}
              />
            );
          })}

          {/* Shared stop labels — rendered once near the convergence point when zoomed */}
          {!isVertical && sharedStopNames && viewport && (() => {
            const usableWidth = computedSvgWidth - LEFT_MARGIN - RIGHT_PADDING;
            const viewMin = viewport.center - viewport.windowHalf;
            const viewMax = viewport.center + viewport.windowHalf;
            const scaleX  = (cx: number) =>
              LEFT_MARGIN + ((cx - viewMin) / (viewMax - viewMin)) * usableWidth;
            // Place the label above the convergence point (or above the top strip if only 1 line)
            const labelY = sharedStopMidY !== null ? sharedStopMidY - 10 : 16;

            // Collect unique shared stops (by norm name) from the first line that contains each
            const norm = (n: string) => n.replace(/ Station$/, '').toLowerCase().trim();
            const rendered = new Set<string>();
            const labels: { cx: number; name: string }[] = [];
            for (const line of visibleLines) {
              for (const stop of line.stops) {
                const n = norm(stop.stopName);
                if (!sharedStopNames.has(n) || rendered.has(n)) continue;
                if (stop.canonicalX < viewMin || stop.canonicalX > viewMax) continue;
                rendered.add(n);
                labels.push({ cx: scaleX(stop.canonicalX), name: stop.stopName.replace(/ Station$/, '') });
              }
            }

            return labels.map(({ cx, name }) => (
              <text key={name}
                transform={`rotate(-48, ${cx}, ${labelY})`}
                x={cx + 2} y={labelY}
                fill="#18181b" fontSize={13} fontWeight={600}
                style={{ cursor: 'default' }}>
                {name}
              </text>
            ));
          })()}
        </svg>
      </div>

      <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 100 }}>
        <TrainInfoPanel />
      </div>
    </div>
  );
}
