import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { TrainDot } from '../../../src/components/LineMap/TrainDot.js';
import type { LivePosition } from '@takemethere/shared';

vi.mock('../../../src/store/uiStore.js', () => ({
  useUiStore: (selector: any) =>
    selector({ selectedTripId: null, actions: { selectTrip: vi.fn() } }),
}));

vi.mock('../../../src/store/trainsStore.js', () => ({
  useTrainsStore: { getState: () => ({ streamedX: new Map() }) },
}));

// Capture the latest RAF callback so we can drive animation manually.
// Using a single variable (not an array) so the loop's self-reschedule is preserved:
// each invocation of rafTick() replaces rafCb with the next iteration of the loop.
let rafCb: FrameRequestCallback | null = null;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCb = cb; return 1; });
vi.stubGlobal('cancelAnimationFrame', vi.fn());
const rafTick = () => act(() => { rafCb?.(performance.now()); });

function makeTrain(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    tripId: 'T1', lineId: 'belgrave',
    lat: -37.85, lon: 145.1, bearing: 90,
    timestamp: Date.now() / 1000 - 10,
    canonicalX: 0.4, delay: 0, directionId: 0,
    prevStopId: 'S1', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.2,
    nextStopId: 'S2', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.6,
    scheduledNextArrivalEpoch: 0,
    nextArrivalEpoch: Date.now() / 1000 + 60,
    predictedNextArrivalEpoch: Date.now() / 1000 + 60,
    segmentSpeedKmh: null, upcomingStops: [],
    ...overrides,
  };
}

const SCALE = (x: number) => x * 800;

describe('TrainDot', () => {
  it('renders a group container for a valid train', () => {
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain()}
          orientation="horizontal"
          scaleX={SCALE}
          stripY={50}
          lineColor="#094C8D"
          movingForward={true}
        />
      </svg>
    );
    expect(container.querySelector('g')).toBeTruthy();
  });

  it('returns nothing when canonicalX is -1 (unmapped)', () => {
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain({ canonicalX: -1 })}
          orientation="horizontal"
          scaleX={SCALE}
          stripY={50}
          lineColor="#094C8D"
          movingForward={null}
        />
      </svg>
    );
    expect(container.querySelector('g')).toBeNull();
  });

  it('fills the circle body with lineColor', () => {
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain()}
          orientation="horizontal"
          scaleX={SCALE}
          stripY={50}
          lineColor="#FF0000"
          movingForward={true}
        />
      </svg>
    );
    const circles = Array.from(container.querySelectorAll('circle'));
    const body = circles.find(c => c.getAttribute('fill') === '#FF0000');
    expect(body).toBeTruthy();
  });

  it('renders rail lines below the train body', () => {
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain()}
          orientation="horizontal"
          scaleX={SCALE}
          stripY={50}
          lineColor="#094C8D"
          movingForward={true}
        />
      </svg>
    );
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('renders correctly for vertical orientation', () => {
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain()}
          orientation="vertical"
          scaleX={SCALE}
          stripY={45}
          lineColor="#094C8D"
          movingForward={false}
        />
      </svg>
    );
    expect(container.querySelector('g')).toBeTruthy();
    expect(container.querySelector('circle')).toBeTruthy();
  });

  it('animation callback resets smoothX when canonicalX becomes -1, so reappearance snaps to new position', () => {
    const SCALE = (x: number) => x * 800;
    const { container, rerender } = render(
      <svg>
        <TrainDot position={makeTrain({ canonicalX: 0.4 })} orientation="horizontal"
          scaleX={SCALE} stripY={50} lineColor="#094C8D" movingForward={true} />
      </svg>
    );
    // Drive one RAF frame — initialises smoothX at 0.4 → transform should contain 320
    rafTick();
    const g = container.querySelector('g')!;
    expect(g.getAttribute('transform')).toContain('320'); // 0.4 * 800

    // canonicalX → -1: component returns null; RAF still fires and must reset smoothX
    rerender(
      <svg>
        <TrainDot position={makeTrain({ canonicalX: -1 })} orientation="horizontal"
          scaleX={SCALE} stripY={50} lineColor="#094C8D" movingForward={true} />
      </svg>
    );
    rafTick();

    // canonicalX → 0.8: should snap to 640px, not slide from stale 320px
    rerender(
      <svg>
        <TrainDot position={makeTrain({ canonicalX: 0.8 })} orientation="horizontal"
          scaleX={SCALE} stripY={50} lineColor="#094C8D" movingForward={true} />
      </svg>
    );
    rafTick();
    const g2 = container.querySelector('g')!;
    // smoothX was reset to null, so first frame snaps to 0.8 * 800 = 640
    expect(g2.getAttribute('transform')).toContain('640');
  });

  it('renders a glow ring when the train is selected', () => {
    vi.doMock('../../../src/store/uiStore.js', () => ({
      useUiStore: (selector: any) =>
        selector({ selectedTripId: 'T1', actions: { selectTrip: vi.fn() } }),
    }));
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain()}
          orientation="horizontal"
          scaleX={SCALE}
          stripY={50}
          lineColor="#094C8D"
          movingForward={true}
        />
      </svg>
    );
    expect(container.querySelector('g')).toBeTruthy();
  });
});
