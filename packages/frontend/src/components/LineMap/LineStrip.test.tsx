import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { LineStrip } from './LineStrip.js';
import type { LineDefinition, LivePosition } from '@takemethere/shared';

vi.mock('../../store/uiStore.js', () => ({
  useUiStore: (selector: any) =>
    selector({ selectedStopName: null, actions: { selectStop: vi.fn() } }),
}));

vi.mock('../../socket/hooks.js', () => ({ useLineRoom: vi.fn() }));

// Default linesStore mock — overridden per test when needed
const mockLinesStore = vi.fn((selector: any) =>
  selector({ directionFilter: 'both', selectedLineIds: new Set(), orientation: 'horizontal', lines: [], actions: {} }),
);
vi.mock('../../store/linesStore.js', () => ({
  useLinesStore: (...args: any[]) => mockLinesStore(...args),
}));

const MOCK_LINE: LineDefinition = {
  lineId: 'belgrave',
  name: 'Belgrave',
  color: '#094C8D',
  stops: [
    { stopId: '1', stopName: 'Flinders Street Station', canonicalX: 0,    canonicalPosition: 1, stopLat: -37.818, stopLon: 144.967 },
    { stopId: '2', stopName: 'Richmond Station',        canonicalX: 0.1,  canonicalPosition: 2, stopLat: -37.824, stopLon: 144.990 },
    { stopId: '3', stopName: 'Camberwell Station',      canonicalX: 0.5,  canonicalPosition: 3, stopLat: -37.824, stopLon: 145.060 },
    { stopId: '4', stopName: 'Belgrave Station',        canonicalX: 1,    canonicalPosition: 4, stopLat: -37.902, stopLon: 145.355 },
  ],
};

function makeTrain(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    tripId: 't1',
    lineId: 'belgrave',
    lat: -37.85,
    lon: 145.1,
    bearing: 90,
    timestamp: Date.now() / 1000 - 10,
    canonicalX: 0.3,
    delay: 0,
    nextStopId: '3',
    nextStopCanonicalX: 0.5,
    nextArrivalEpoch: Date.now() / 1000 + 60,
    directionId: 0,
    ...overrides,
  };
}

const BASE_PROPS = {
  line: MOCK_LINE,
  trains: [],
  stripIndex: 0,
  stripHeight: 100,
  svgWidth: 800,
  svgHeight: 620,
};

describe('LineStrip', () => {
  describe('horizontal orientation', () => {
    it('renders a horizontal rail line (y1 === y2)', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>
      );
      const rail = container.querySelector('line');
      expect(rail).toBeTruthy();
      expect(rail!.getAttribute('y1')).toBe(rail!.getAttribute('y2'));
    });

    it('renders station dots', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>
      );
      const circles = container.querySelectorAll('circle');
      expect(circles).toHaveLength(4);
    });

    it('strips " Station" suffix from labels', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>
      );
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
      expect(texts.some(t => t === 'Flinders Street')).toBe(true);
      expect(texts.every(t => !t?.endsWith(' Station'))).toBe(true);
    });

    it('does not render past the last stop (x2 <= svgWidth)', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>
      );
      const rail = container.querySelector('line');
      const x2 = parseFloat(rail!.getAttribute('x2')!);
      expect(x2).toBeLessThanOrEqual(800);
    });
  });

  describe('vertical orientation', () => {
    it('renders a vertical rail line (x1 === x2)', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="vertical" /></svg>
      );
      const rail = container.querySelector('line');
      expect(rail).toBeTruthy();
      expect(rail!.getAttribute('x1')).toBe(rail!.getAttribute('x2'));
    });

    it('rail line runs top-to-bottom (y2 > y1)', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="vertical" /></svg>
      );
      const rail = container.querySelector('line');
      const y1 = parseFloat(rail!.getAttribute('y1')!);
      const y2 = parseFloat(rail!.getAttribute('y2')!);
      expect(y2).toBeGreaterThan(y1);
    });

    it('station dots share the same x as the rail line', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="vertical" /></svg>
      );
      const rail = container.querySelector('line');
      const railX = rail!.getAttribute('x1')!;
      const circles = container.querySelectorAll('circle');
      circles.forEach(c => {
        expect(c.getAttribute('cx')).toBe(railX);
      });
    });

    it('line name appears above the station dots', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="vertical" /></svg>
      );
      const rail = container.querySelector('line');
      const y1 = parseFloat(rail!.getAttribute('y1')!);
      const nameText = Array.from(container.querySelectorAll('text')).find(t => t.textContent === 'Belgrave');
      expect(nameText).toBeTruthy();
      const nameY = parseFloat(nameText!.getAttribute('y')!);
      expect(nameY).toBeLessThan(y1);
    });

    it('strips " Station" suffix in vertical mode', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="vertical" /></svg>
      );
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
      expect(texts.every(t => !t?.endsWith(' Station'))).toBe(true);
    });
  });

  describe('orientation invariants', () => {
    it('horizontal and vertical render the same number of station dots', () => {
      const { container: h } = render(<svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>);
      const { container: v } = render(<svg><LineStrip {...BASE_PROPS} orientation="vertical" /></svg>);
      expect(h.querySelectorAll('circle').length).toBe(v.querySelectorAll('circle').length);
    });

    it('returns null when there are no stops', () => {
      const emptyLine = { ...MOCK_LINE, stops: [] };
      const { container } = render(<svg><LineStrip {...BASE_PROPS} line={emptyLine} orientation="horizontal" /></svg>);
      expect(container.querySelector('g')).toBeNull();
    });
  });

  describe('direction filter', () => {
    const outboundTrain = makeTrain({ tripId: 'out', directionId: 0 }); // outbound
    const inboundTrain  = makeTrain({ tripId: 'in',  directionId: 1 }); // inbound
    const unknownTrain  = makeTrain({ tripId: 'unk', directionId: null }); // unknown

    function renderWithFilter(directionFilter: string) {
      mockLinesStore.mockImplementation((selector: any) =>
        selector({ directionFilter, selectedLineIds: new Set(), orientation: 'horizontal', lines: [], actions: {} })
      );
      return render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            trains={[outboundTrain, inboundTrain, unknownTrain]}
          />
        </svg>
      );
    }

    // Each TrainDot renders 3 circles: background + 2 headlights
    const CIRCLES_PER_TRAIN = 3;
    const STOP_CIRCLES = 4;

    it('shows all trains when filter is "both"', () => {
      const { container } = renderWithFilter('both');
      const circles = container.querySelectorAll('circle');
      expect(circles).toHaveLength(STOP_CIRCLES + 3 * CIRCLES_PER_TRAIN);
    });

    it('shows only outbound trains when filter is "outbound"', () => {
      const { container } = renderWithFilter('outbound');
      // outbound (1) + unknown (1) = 2 trains
      const circles = container.querySelectorAll('circle');
      expect(circles).toHaveLength(STOP_CIRCLES + 2 * CIRCLES_PER_TRAIN);
    });

    it('shows only inbound trains when filter is "inbound"', () => {
      const { container } = renderWithFilter('inbound');
      // inbound (1) + unknown (1) = 2 trains
      const circles = container.querySelectorAll('circle');
      expect(circles).toHaveLength(STOP_CIRCLES + 2 * CIRCLES_PER_TRAIN);
    });

    it('trains with unknown direction appear in both inbound and outbound views', () => {
      const { container: outContainer } = renderWithFilter('outbound');
      const { container: inContainer }  = renderWithFilter('inbound');
      const expected = STOP_CIRCLES + 2 * CIRCLES_PER_TRAIN;
      expect(outContainer.querySelectorAll('circle').length).toBe(expected);
      expect(inContainer.querySelectorAll('circle').length).toBe(expected);
    });
  });
});
