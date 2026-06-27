import { useRef } from 'react';
import type { LivePosition } from '@takemethere/shared';
import { useUiStore } from '../../store/uiStore.js';
import { useAnimationFrame } from '../../hooks/useAnimationFrame.js';

interface Props {
  position: LivePosition;
  orientation: 'horizontal' | 'vertical';
  scaleX: (canonicalX: number) => number;
  stripY: number;
  lineColor: string;
  movingForward: boolean | null;
}

// Train shape is drawn pointing RIGHT at rotation=0, centered at (0,0).
// Body: x=-10 to x=6, y=-4 to y=4 (rx=2.5)
// Nose (when direction known): triangle from x=6 to x=11, tapered
const BODY_W = 16;
const BODY_H = 8;
const BODY_X = -10;
const NOSE_BASE_X = 6;
const NOSE_TIP_X = 11;

export function TrainDot({ position, orientation, scaleX, stripY, lineColor, movingForward }: Props) {
  const gRef = useRef<SVGGElement>(null);
  const smoothX = useRef<number | null>(null);
  const selectedTripId = useUiStore(s => s.selectedTripId);
  const selectTrip     = useUiStore(s => s.actions.selectTrip);

  useAnimationFrame((nowMs) => {
    if (!gRef.current || position.canonicalX < 0) return;

    // Dead-reckon toward next stop — works in both directions
    let targetX = position.canonicalX;
    const hasNext = position.nextArrivalEpoch > 0
      && position.nextStopCanonicalX >= 0
      && Math.abs(position.nextStopCanonicalX - position.canonicalX) > 0.002;

    if (hasNext) {
      const nowEpoch = nowMs / 1000;
      const elapsed  = nowEpoch - position.timestamp;
      const total    = position.nextArrivalEpoch - position.timestamp;
      if (total > 0 && elapsed > 0) {
        const t   = Math.min(1, elapsed / total);
        const raw = position.canonicalX + t * (position.nextStopCanonicalX - position.canonicalX);
        const lo  = Math.min(position.canonicalX, position.nextStopCanonicalX);
        const hi  = Math.max(position.canonicalX, position.nextStopCanonicalX);
        targetX   = Math.max(lo, Math.min(hi, raw));
      }
    }

    // Exponential smoothing — removes GPS jitter at poll boundaries without perceptible lag
    if (smoothX.current === null) smoothX.current = targetX;
    else smoothX.current += (targetX - smoothX.current) * 0.12;

    const coord = scaleX(smoothX.current);

    let tx: number, ty: number, rotation: number;
    if (orientation === 'horizontal') {
      tx = coord; ty = stripY;
      // 0° = pointing right (outbound), 180° = pointing left (inbound)
      rotation = movingForward === false ? 180 : 0;
    } else {
      tx = stripY; ty = coord;
      // 90° = pointing down (outbound), 270° = pointing up (inbound)
      rotation = movingForward === false ? 270 : 90;
    }

    gRef.current.setAttribute('transform', `translate(${tx},${ty}) rotate(${rotation})`);
  });

  if (position.canonicalX < 0) return null;

  const isSelected  = selectedTripId === position.tripId;
  const hasSelection = selectedTripId !== null;
  const strokeColor  = isSelected ? '#ffcc00' : '#fff';
  const strokeWidth  = isSelected ? 2 : 1.5;
  const opacity      = hasSelection && !isSelected ? 0.25 : 1;

  return (
    <g
      ref={gRef}
      opacity={opacity}
      style={{ cursor: 'pointer' }}
      onClick={() => selectTrip(isSelected ? null : position.tripId)}
    >
      {/* Transparent hit area */}
      <circle r={14} fill="transparent" />

      {/* Selection glow */}
      {isSelected && (
        <rect
          x={BODY_X - 3} y={-(BODY_H / 2) - 3}
          width={BODY_W + 6} height={BODY_H + 6}
          rx={4}
          fill="none"
          stroke="#ffcc00"
          strokeWidth={2}
          opacity={0.5}
        />
      )}

      {/* Train body */}
      <rect
        x={BODY_X} y={-(BODY_H / 2)}
        width={BODY_W} height={BODY_H}
        rx={2.5}
        fill={lineColor}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />

      {/* Window strip */}
      <rect
        x={BODY_X + 3} y={-(BODY_H / 2) + 2}
        width={BODY_W - 7} height={BODY_H - 4}
        rx={1}
        fill="white"
        opacity={0.25}
      />

      {/* Nose — only when direction is known */}
      {movingForward !== null && (
        <polygon
          points={`${NOSE_BASE_X},${-(BODY_H / 2)} ${NOSE_TIP_X},0 ${NOSE_BASE_X},${BODY_H / 2}`}
          fill={lineColor}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
        />
      )}
    </g>
  );
}
