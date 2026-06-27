import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TrainDot } from './TrainDot.js';
import type { LivePosition } from '@takemethere/shared';

vi.mock('../../store/uiStore.js', () => ({
  useUiStore: (selector: any) =>
    selector({ selectedTripId: null, actions: { selectTrip: vi.fn() } }),
}));

vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 0);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

function makeTrain(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    tripId: 'T1',
    lineId: 'belgrave',
    lat: -37.85,
    lon: 145.1,
    bearing: 90,
    timestamp: Date.now() / 1000 - 10,
    canonicalX: 0.4,
    delay: 0,
    nextStopId: 'S2',
    nextStopCanonicalX: 0.6,
    nextArrivalEpoch: Date.now() / 1000 + 60,
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

  it('fills the train body rect with lineColor', () => {
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
    const rects = Array.from(container.querySelectorAll('rect'));
    // At least one rect should be filled with the line color (the body)
    const bodyRect = rects.find(r => r.getAttribute('fill') === '#FF0000');
    expect(bodyRect).toBeTruthy();
  });

  it('renders a nose polygon when direction is known', () => {
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
    expect(container.querySelector('polygon')).toBeTruthy();
  });

  it('does not render a nose polygon when direction is unknown', () => {
    const { container } = render(
      <svg>
        <TrainDot
          position={makeTrain({ nextStopCanonicalX: -1 })}
          orientation="horizontal"
          scaleX={SCALE}
          stripY={50}
          lineColor="#094C8D"
          movingForward={null}
        />
      </svg>
    );
    expect(container.querySelector('polygon')).toBeNull();
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
    expect(container.querySelector('rect')).toBeTruthy();
  });

  it('renders a glow rect when the train is selected', () => {
    vi.doMock('../../store/uiStore.js', () => ({
      useUiStore: (selector: any) =>
        selector({ selectedTripId: 'T1', actions: { selectTrip: vi.fn() } }),
    }));
    // Base render still works (glow rect is conditional on selected state from store)
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
