import { useRef, type ReactNode } from 'react';
import type { LivePosition } from '@takemethere/shared';
import { useUiStore } from '../../store/uiStore.js';
import { useTrainsStore } from '../../store/trainsStore.js';
import { useAnimationFrame } from '../../hooks/useAnimationFrame.js';

interface Props {
  position: LivePosition;
  orientation: 'horizontal' | 'vertical';
  scaleX: (canonicalX: number) => number;
  stripY: number;
  lineColor: string;
  movingForward: boolean | null;
}

const RADIUS = 12;

// All geometry scales linearly with R. Values chosen to match the icon at R=15.
const R = RADIUS;
const s = R / 15; // scale factor — 1.0 at default size

// Body
const BW  = 7 * s;   // half-width
const BY  = -10 * s; // top y
const BH  = 14 * s;  // height
const BRX = 3 * s;   // corner radius

// Windscreen
const WX  = 5 * s;   // half-width
const WY  = -8 * s;  // top y
const WH  = 5 * s;   // height

// Door line
const DY1 = -3 * s;
const DY2 = 4 * s;

// Lights
const LCX = 3.5 * s;
const LCY = 2 * s;
const LR  = 1.1 * s;

// Rails
const RIX = 5 * s;  // inner x
const RIY = 7 * s;  // inner y
const ROX = 8 * s;  // outer x
const ROY = 10 * s; // outer y

export function TrainDot({ position, orientation, scaleX, stripY, lineColor, movingForward }: Props) {
  const gRef = useRef<SVGGElement>(null);
  const smoothX = useRef<number | null>(null);
  const selectedTripId = useUiStore(s => s.selectedTripId);
  const selectTrip     = useUiStore(s => s.actions.selectTrip);
  useAnimationFrame(() => {
    if (!gRef.current || position.canonicalX < 0) return;

    // Read streamed position directly from store outside React render cycle
    // (avoids 87 re-renders/sec from streamedX map updates)
    const streamedX = useTrainsStore.getState().streamedX.get(position.tripId);
    const targetX = streamedX ?? position.canonicalX;

    // Exponential smoothing glides between 1Hz server ticks at 60fps
    if (smoothX.current === null) smoothX.current = targetX;
    else smoothX.current += (targetX - smoothX.current) * 0.12;

    const coord = scaleX(smoothX.current);

    let tx: number, ty: number;
    if (orientation === 'horizontal') {
      tx = coord; ty = stripY;
    } else {
      tx = stripY; ty = coord;
    }

    gRef.current.setAttribute('transform', `translate(${tx},${ty})`);
  });

  if (position.canonicalX < 0) return null;

  const isSelected   = selectedTripId === position.tripId;
  const hasSelection = selectedTripId !== null;
  const opacity      = hasSelection && !isSelected ? 0.25 : 1;

  // Direction arrow: filled triangle outside the circle on the leading edge.
  // Base sits just outside the circle; tip extends further beyond it.
  const ARR_BASE = R + 2 * s;   // base distance from centre (just outside circle)
  const ARR_TIP  = R + 9 * s;   // tip distance from centre
  const ARR_H    = 5 * s;       // half-height of the base

  let directionArrow: ReactNode = null;
  if (movingForward === true) {
    directionArrow = orientation === 'horizontal'
      ? <polygon points={`${ARR_TIP},0 ${ARR_BASE},-${ARR_H} ${ARR_BASE},${ARR_H}`}   fill="white" stroke={lineColor} strokeWidth={1} />
      : <polygon points={`0,${ARR_TIP} -${ARR_H},${ARR_BASE} ${ARR_H},${ARR_BASE}`}   fill="white" stroke={lineColor} strokeWidth={1} />;
  } else if (movingForward === false) {
    directionArrow = orientation === 'horizontal'
      ? <polygon points={`-${ARR_TIP},0 -${ARR_BASE},-${ARR_H} -${ARR_BASE},${ARR_H}`} fill="white" stroke={lineColor} strokeWidth={1} />
      : <polygon points={`0,-${ARR_TIP} -${ARR_H},-${ARR_BASE} ${ARR_H},-${ARR_BASE}`} fill="white" stroke={lineColor} strokeWidth={1} />;
  }

  return (
      <g
          ref={gRef}
          opacity={opacity}
          style={{ cursor: 'pointer' }}
          onClick={() => selectTrip(isSelected ? null : position.tripId)}
      >
        {/* Selection ring */}
        {isSelected && (
            <circle r={R + 4 * s} fill="none" stroke="#ffcc00" strokeWidth={2.5 * s} opacity={0.75} />
        )}

        {/* Background */}
        <circle r={R} fill={lineColor} stroke="white" strokeWidth={1.5 * s} />

        {/* Train body */}
        <rect x={-BW} y={BY} width={BW * 2} height={BH} rx={BRX} fill="white" />

        {/* Windscreen */}
        <rect x={-WX} y={WY} width={WX * 2} height={WH} rx={1.5 * s} fill={lineColor} opacity={0.95} />

        {/* Door */}
        <line x1={0} y1={DY1} x2={0} y2={DY2} stroke={lineColor} strokeWidth={1.2 * s} />

        {/* Lights */}
        <circle cx={-LCX} cy={LCY} r={LR} fill={lineColor} />
        <circle cx={LCX}  cy={LCY} r={LR} fill={lineColor} />

        {/* Coupler */}
        <line x1={0} y1={DY2} x2={0} y2={DY2 + 2 * s} stroke="white" strokeWidth={1.5 * s} strokeLinecap="round" />

        {/* Rails */}
        <line x1={-RIX} y1={RIY} x2={-ROX} y2={ROY} stroke="white" strokeWidth={1.4 * s} strokeLinecap="round" />
        <line x1={RIX}  y1={RIY} x2={ROX}  y2={ROY} stroke="white" strokeWidth={1.4 * s} strokeLinecap="round" />

        {/* Direction pointer */}
        {directionArrow}
      </g>
  );
}
