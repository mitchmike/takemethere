import { useRef, useEffect } from 'react';
import type { LivePosition, LineStationEntry } from '@takemethere/shared';
import { useUiStore } from '../../store/uiStore.js';

interface Props {
  position: LivePosition;
  stops: LineStationEntry[];
  orientation: 'horizontal' | 'vertical';
  scaleX: (canonicalX: number) => number;
  stripY: number;
}

export function TrainDot({ position, stops, orientation, scaleX, stripY }: Props) {
  const circleRef = useRef<SVGCircleElement>(null);
  const selectedTripId = useUiStore(s => s.selectedTripId);
  const selectTrip = useUiStore(s => s.actions.selectTrip);

  const stopBefore = stops.find(s => s.canonicalPosition === position.stopSequenceBefore);
  const stopAfter = stops.find(s => s.canonicalPosition === position.stopSequenceAfter);

  useEffect(() => {
    if (!circleRef.current || !stopBefore || !stopAfter) return;

    const x0 = scaleX(stopBefore.canonicalX);
    const x1 = scaleX(stopAfter.canonicalX);
    const cx = x0 + position.fraction * (x1 - x0);

    if (orientation === 'horizontal') {
      circleRef.current.setAttribute('cx', String(cx));
      circleRef.current.setAttribute('cy', String(stripY));
    } else {
      circleRef.current.setAttribute('cx', String(stripY));
      circleRef.current.setAttribute('cy', String(cx));
    }
  });

  const isSelected = selectedTripId === position.tripId;
  const hasSelection = selectedTripId !== null;

  return (
    <circle
      ref={circleRef}
      r={6}
      fill="white"
      opacity={hasSelection && !isSelected ? 0.2 : 1}
      stroke={isSelected ? '#ffcc00' : 'none'}
      strokeWidth={isSelected ? 2 : 0}
      style={{ cursor: 'pointer' }}
      onClick={() => selectTrip(isSelected ? null : position.tripId)}
    />
  );
}
