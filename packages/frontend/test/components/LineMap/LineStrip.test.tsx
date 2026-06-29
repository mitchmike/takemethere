import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { LineStrip, LEFT_MARGIN, RIGHT_PADDING } from '../../../src/components/LineMap/LineStrip.js';
import type { LineDefinition, LivePosition } from '@takemethere/shared';

vi.mock('../../../src/store/uiStore.js', () => ({
  useUiStore: (selector: any) =>
    selector({ selectedStopName: null, actions: { selectStop: vi.fn() } }),
}));

vi.mock('../../../src/socket/hooks.js', () => ({ useLineRoom: vi.fn() }));

// Default linesStore mock — overridden per test when needed
const mockLinesStore = vi.fn((selector: any) =>
  selector({ directionFilter: 'both', selectedLineIds: new Set(), orientation: 'horizontal', lines: [], actions: {} }),
);
vi.mock('../../../src/store/linesStore.js', () => ({
  useLinesStore: (selector: any) => mockLinesStore(selector),
}));

const MOCK_LINE: LineDefinition = {
  lineId: 'belgrave',
  name: 'Belgrave',
  color: '#094C8D',
  stops: [
    { lineId: 'belgrave', stopId: '1', stopName: 'Flinders Street Station', canonicalX: 0,    canonicalPosition: 1, stopLat: -37.818, stopLon: 144.967 },
    { lineId: 'belgrave', stopId: '2', stopName: 'Richmond Station',        canonicalX: 0.1,  canonicalPosition: 2, stopLat: -37.824, stopLon: 144.990 },
    { lineId: 'belgrave', stopId: '3', stopName: 'Camberwell Station',      canonicalX: 0.5,  canonicalPosition: 3, stopLat: -37.824, stopLon: 145.060 },
    { lineId: 'belgrave', stopId: '4', stopName: 'Belgrave Station',        canonicalX: 1,    canonicalPosition: 4, stopLat: -37.902, stopLon: 145.355 },
  ],
};

function makeTrain(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    tripId: 't1', lineId: 'belgrave',
    lat: -37.85, lon: 145.1, bearing: 90,
    timestamp: Date.now() / 1000 - 10,
    canonicalX: 0.3, delay: 0, directionId: 0,
    prevStopId: '2', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
    nextStopId: '3', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
    scheduledNextArrivalEpoch: 0,
    nextArrivalEpoch: Date.now() / 1000 + 60,
    predictedNextArrivalEpoch: Date.now() / 1000 + 60,
    segmentSpeedKmh: null, upcomingStops: [],
    ...overrides,
  };
}

const BASE_PROPS = {
  line: MOCK_LINE,
  trains: [],
  allPositions: new Map(),
  stripIndex: 0,
  stripHeight: 100,
  svgWidth: 800,
  svgHeight: 620,
  viewport: null,
  selectedTripId: null,
  showTimes: false,
  focusStopNames: null,
  sharedStopNames: null,
  isFocusLine: false,
  sharedStopY: null,
};

describe('LineStrip', () => {
  describe('horizontal orientation', () => {
    it('renders a horizontal rail polyline', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>
      );
      const rail = container.querySelector('polyline');
      expect(rail).toBeTruthy();
      // Without a viewport all stops are at lineY — all y values in points should be equal
      const pts = rail!.getAttribute('points')!.trim().split(/\s+/).map(p => parseFloat(p.split(',')[1]));
      const firstY = pts[0];
      expect(pts.every(y => y === firstY)).toBe(true);
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

    it('does not render past the last stop (rightmost x <= svgWidth)', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="horizontal" /></svg>
      );
      const rail = container.querySelector('polyline');
      const pts = rail!.getAttribute('points')!.trim().split(/\s+/);
      const lastX = parseFloat(pts[pts.length - 1].split(',')[0]);
      expect(lastX).toBeLessThanOrEqual(800);
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

  // ── Helpers for step-effect tests ───────────────────────────────────────────
  // MOCK_LINE stops: Flinders(cx=0), Richmond(cx=0.1), Camberwell(cx=0.5), Belgrave(cx=1)
  // VIEWPORT = { center:0.5, windowHalf:0.4 } → viewMin=0.1, viewMax=0.9
  // Visible in that viewport: Richmond(0.1) and Camberwell(0.5)  [Flinders and Belgrave are out]
  // lineY for strip 0 = 0*100 + round(100*0.78) = 78
  const ZOOM_VIEWPORT = { center: 0.5, windowHalf: 0.4 };
  const lineY = Math.round(100 * 0.78); // = 78
  const SHARED_Y = 120; // arbitrary sharedStopY between lineY(78) and some midY

  function parsePolylinePts(container: Element) {
    const rail = container.querySelector('polyline')!;
    return rail.getAttribute('points')!.trim().split(/\s+/).map(p => {
      const [x, y] = p.split(',').map(parseFloat);
      return { x, y };
    });
  }

  function camberwellPx() {
    // scaleX(0.5) with viewMin=0.1, viewMax=0.9, svgWidth=800
    return LEFT_MARGIN + ((0.5 - 0.1) / 0.8) * (800 - LEFT_MARGIN - RIGHT_PADDING);
  }
  function richmondPx() {
    // scaleX(0.1) = LEFT_MARGIN (viewMin edge)
    return LEFT_MARGIN + ((0.1 - 0.1) / 0.8) * (800 - LEFT_MARGIN - RIGHT_PADDING);
  }

  describe('req 1 — lines closer together at shared sections', () => {
    it('shared stop circle cy equals sharedStopY (not lineY)', () => {
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['camberwell'])}
            sharedStopY={new Map([['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      // Camberwell is at canonicalX=0.5, shared → circle cy should be SHARED_Y
      const circles = Array.from(container.querySelectorAll('circle'));
      const camberwellCircle = circles.find(c => {
        const cx = parseFloat(c.getAttribute('cx') ?? '');
        return Math.abs(cx - camberwellPx()) < 1;
      });
      expect(camberwellCircle).toBeTruthy();
      expect(parseFloat(camberwellCircle!.getAttribute('cy')!)).toBe(SHARED_Y);
    });

    it('non-shared stop circle cy equals lineY', () => {
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['camberwell'])} // Richmond NOT shared
            sharedStopY={new Map([['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      const circles = Array.from(container.querySelectorAll('circle'));
      const richmondCircle = circles.find(c => {
        const cx = parseFloat(c.getAttribute('cx') ?? '');
        return Math.abs(cx - richmondPx()) < 1;
      });
      expect(richmondCircle).toBeTruthy();
      expect(parseFloat(richmondCircle!.getAttribute('cy')!)).toBe(lineY);
    });
  });

  describe('req 2 — step AT the shared station, not before it', () => {
    it('when first visible stop is non-shared, y-change in polyline occurs at the shared stop x', () => {
      // Richmond(non-shared) is before Camberwell(shared) in the viewport.
      // The rail should be flat at lineY until it reaches Camberwell's x, then step.
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['camberwell'])}
            sharedStopY={new Map([['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      const pts = parsePolylinePts(container);
      const stepX = camberwellPx();

      // All points strictly before Camberwell's x must be at lineY
      const prematureStep = pts.find(p => p.x < stepX - 1 && p.y !== lineY);
      expect(prematureStep).toBeUndefined();

      // There must be a point at Camberwell's x with y = SHARED_Y
      const stepPoint = pts.find(p => Math.abs(p.x - stepX) < 1 && p.y === SHARED_Y);
      expect(stepPoint).toBeTruthy();
    });

    it('polyline segments are always horizontal or vertical — no diagonals', () => {
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['camberwell'])}
            sharedStopY={new Map([['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      const pts = parsePolylinePts(container);
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        expect(dx === 0 || dy === 0).toBe(true); // horizontal OR vertical
      }
    });
  });

  describe('req 3 — trains stay on the line (follow rail y)', () => {
    it('train with null prevStopName does not crash', () => {
      const trainNullPrev = makeTrain({ prevStopName: null as any });
      expect(() =>
        render(
          <svg>
            <LineStrip
              {...BASE_PROPS}
              orientation="horizontal"
              viewport={ZOOM_VIEWPORT}
              sharedStopNames={new Set(['camberwell'])}
              sharedStopY={new Map([['camberwell', SHARED_Y]])}
              trains={[trainNullPrev]}
            />
          </svg>
        )
      ).not.toThrow();
    });

  });

  describe('req 4 — no fanning at city end when lines are still together', () => {
    it('when all visible stops are shared, polyline stays at sharedStopY throughout', () => {
      // Both Richmond and Camberwell are shared — entire visible section is shared.
      // The polyline should be flat at SHARED_Y with no segments at lineY.
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['richmond', 'camberwell'])}
            sharedStopY={new Map([['richmond', SHARED_Y], ['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      const pts = parsePolylinePts(container);
      const fanOut = pts.find(p => p.y === lineY);
      expect(fanOut).toBeUndefined();
      expect(pts.every(p => p.y === SHARED_Y)).toBe(true);
    });

    it('when first visible stop is shared, left edge of polyline is at sharedStopY not lineY', () => {
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['richmond', 'camberwell'])} // Richmond first = shared
            sharedStopY={new Map([['richmond', SHARED_Y], ['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      const pts = parsePolylinePts(container);
      // First point in the polyline is the left edge
      expect(pts[0].y).toBe(SHARED_Y);
    });
  });

  describe('shared stop label spacing', () => {
    it('non-shared stop label is shown even when adjacent to a shared stop', () => {
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            viewport={ZOOM_VIEWPORT}
            sharedStopNames={new Set(['camberwell'])}
            sharedStopY={new Map([['camberwell', SHARED_Y]])}
          />
        </svg>
      );
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
      expect(texts.some(t => t === 'Richmond')).toBe(true);
    });
  });

  describe('focus line times', () => {
    it('isFocusLine=true shows times even when focusStopNames excludes the stop', () => {
      // This tests that the focus strip bypasses the focusStopNames filter
      const focusStopNames = new Set(['richmond']); // Camberwell intentionally excluded
      const positions = new Map([
        ['t1', {
          tripId: 't1', lineId: 'belgrave', lat: -37.85, lon: 145.1, bearing: 90,
          timestamp: Date.now() / 1000 - 10, canonicalX: 0.3, delay: 0, directionId: 0,
          prevStopId: '2', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
          nextStopId: '3', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
          scheduledNextArrivalEpoch: 0, nextArrivalEpoch: Date.now() / 1000 + 60,
          predictedNextArrivalEpoch: Date.now() / 1000 + 60, segmentSpeedKmh: null,
          upcomingStops: [
            {
              stopId: '3', stopName: 'Camberwell Station', canonicalX: 0.5,
              scheduledArrivalEpoch: Date.now() / 1000 + 120,
              adjustedArrivalEpoch: Date.now() / 1000 + 120,
              predictedArrivalEpoch: Date.now() / 1000 + 120,
              tuDelaySeconds: 0,
            },
          ],
        }],
      ]);

      const VIEWPORT = { center: 0.5, windowHalf: 0.4 };
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            showTimes={true}
            viewport={VIEWPORT}
            allPositions={positions as any}
            focusStopNames={focusStopNames}
            isFocusLine={true}
          />
        </svg>
      );
      // There should be at least one time text (Camberwell arrival) even though
      // focusStopNames only contains 'richmond'
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent ?? '');
      const hasTime = texts.some(t => /\d{2}:\d{2}/.test(t));
      expect(hasTime).toBe(true);
    });
  });

  describe('times y follows stopY (req 2)', () => {
    it('time text for a shared stop renders below sharedStopY, not lineY', () => {
      const sharedY = 120;
      const positions = new Map([
        ['t1', {
          tripId: 't1', lineId: 'belgrave', lat: -37.85, lon: 145.1, bearing: 90,
          timestamp: Date.now() / 1000 - 10, canonicalX: 0.3, delay: 0, directionId: 0,
          prevStopId: '2', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
          nextStopId: '3', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
          scheduledNextArrivalEpoch: 0, nextArrivalEpoch: Date.now() / 1000 + 60,
          predictedNextArrivalEpoch: Date.now() / 1000 + 60, segmentSpeedKmh: null,
          upcomingStops: [{
            stopId: '3', stopName: 'Camberwell Station', canonicalX: 0.5,
            scheduledArrivalEpoch: Date.now() / 1000 + 120,
            adjustedArrivalEpoch: Date.now() / 1000 + 120,
            predictedArrivalEpoch: Date.now() / 1000 + 120,
            tuDelaySeconds: 0,
          }],
        }],
      ]);

      const VIEWPORT = { center: 0.5, windowHalf: 0.4 };
      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            showTimes={true}
            viewport={VIEWPORT}
            allPositions={positions as any}
            isFocusLine={true}
            sharedStopNames={new Set(['camberwell'])}
            sharedStopY={new Map([['camberwell', sharedY]])}
          />
        </svg>
      );

      const TIMES_Y_OFFSET = 18;
      const expectedMinY = sharedY + TIMES_Y_OFFSET;
      const texts = Array.from(container.querySelectorAll('text'));
      const timeText = texts.find(t => /\d{2}:\d{2}/.test(t.textContent ?? ''));
      expect(timeText).toBeTruthy();
      const y = parseFloat(timeText!.getAttribute('y')!);
      // sharedY (120) > lineY (78), so times at sharedY produce larger y than times at lineY
      expect(y).toBeGreaterThanOrEqual(expectedMinY - 1); // anchored to sharedY
      expect(y).toBeGreaterThan(lineY + TIMES_Y_OFFSET);  // NOT anchored to lineY
    });
  });

  describe('single-line times (req 4) — priorityTripId', () => {
    it('shows times for focus trip even when its lineId does not match the strip lineId', () => {
      const VIEWPORT = { center: 0.5, windowHalf: 0.4 };
      const mismatchedLineId = 'backend-belgrave-99'; // differs from strip lineId 'belgrave'
      const positions = new Map([
        ['sel', {
          tripId: 'sel', lineId: mismatchedLineId,
          lat: -37.85, lon: 145.1, bearing: 90,
          timestamp: Date.now() / 1000 - 10, canonicalX: 0.3, delay: 0, directionId: 0,
          prevStopId: '2', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
          nextStopId: '3', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
          scheduledNextArrivalEpoch: 0, nextArrivalEpoch: Date.now() / 1000 + 60,
          predictedNextArrivalEpoch: Date.now() / 1000 + 60, segmentSpeedKmh: null,
          upcomingStops: [{
            stopId: '3', stopName: 'Camberwell Station', canonicalX: 0.5,
            scheduledArrivalEpoch: Date.now() / 1000 + 120,
            adjustedArrivalEpoch: Date.now() / 1000 + 120,
            predictedArrivalEpoch: Date.now() / 1000 + 120,
            tuDelaySeconds: 0,
          }],
        }],
      ]);

      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="horizontal"
            showTimes={true}
            viewport={VIEWPORT}
            allPositions={positions as any}
            selectedTripId="sel"
            isFocusLine={true}
            focusStopNames={null}
          />
        </svg>
      );
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent ?? '');
      expect(texts.some(t => /\d{2}:\d{2}/.test(t))).toBe(true);
    });
  });

  describe('vertical times', () => {
    it('renders times in vertical mode when showTimes is true', () => {
      const VIEWPORT = { center: 0.5, windowHalf: 0.4 };
      const positions = new Map([
        ['t1', {
          tripId: 't1', lineId: 'belgrave', lat: -37.85, lon: 145.1, bearing: 90,
          timestamp: Date.now() / 1000 - 10, canonicalX: 0.3, delay: 0, directionId: 0,
          prevStopId: '2', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
          nextStopId: '3', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
          scheduledNextArrivalEpoch: 0, nextArrivalEpoch: Date.now() / 1000 + 60,
          predictedNextArrivalEpoch: Date.now() / 1000 + 60, segmentSpeedKmh: null,
          upcomingStops: [{
            stopId: '3', stopName: 'Camberwell Station', canonicalX: 0.5,
            scheduledArrivalEpoch: Date.now() / 1000 + 120,
            adjustedArrivalEpoch: Date.now() / 1000 + 120,
            predictedArrivalEpoch: Date.now() / 1000 + 120,
            tuDelaySeconds: 0,
          }],
        }],
      ]);

      const { container } = render(
        <svg>
          <LineStrip
            {...BASE_PROPS}
            orientation="vertical"
            showTimes={true}
            viewport={VIEWPORT}
            allPositions={positions as any}
            selectedTripId="t1"
          />
        </svg>
      );
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent ?? '');
      expect(texts.some(t => /\d{2}:\d{2}/.test(t))).toBe(true);
    });

    it('does not render times in vertical mode when showTimes is false', () => {
      const { container } = render(
        <svg><LineStrip {...BASE_PROPS} orientation="vertical" showTimes={false} /></svg>
      );
      const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent ?? '');
      expect(texts.every(t => !/\d{2}:\d{2}/.test(t))).toBe(true);
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
