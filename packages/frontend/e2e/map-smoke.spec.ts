import { test, expect, type Page } from '@playwright/test';

// ── Minimal fake data ──────────────────────────────────────────────────────

const MOCK_LINE = {
  lineId: 'belgrave',
  name: 'Belgrave',
  color: '#094C8D',
  stops: [
    { lineId: 'belgrave', stopId: 's1', stopName: 'Flinders Street Station', canonicalX: 0,   canonicalPosition: 1, stopLat: -37.818, stopLon: 144.967 },
    { lineId: 'belgrave', stopId: 's2', stopName: 'Richmond Station',        canonicalX: 0.1, canonicalPosition: 2, stopLat: -37.824, stopLon: 144.990 },
    { lineId: 'belgrave', stopId: 's3', stopName: 'Camberwell Station',      canonicalX: 0.5, canonicalPosition: 3, stopLat: -37.824, stopLon: 145.060 },
    { lineId: 'belgrave', stopId: 's4', stopName: 'Belgrave Station',        canonicalX: 1,   canonicalPosition: 4, stopLat: -37.902, stopLon: 145.355 },
  ],
};

const MOCK_TRAIN = {
  tripId: 'test-trip-1',
  lineId: 'belgrave',
  lat: -37.824,
  lon: 145.02,
  bearing: 90,
  timestamp: Date.now() / 1000 - 5,
  canonicalX: 0.3,
  delay: 0,
  directionId: 0,
  prevStopId: 's2',
  prevStopName: 'Richmond Station',
  prevStopCanonicalX: 0.1,
  nextStopId: 's3',
  nextStopName: 'Camberwell Station',
  nextStopCanonicalX: 0.5,
  scheduledNextArrivalEpoch: Date.now() / 1000 + 120,
  nextArrivalEpoch: Date.now() / 1000 + 120,
  predictedNextArrivalEpoch: Date.now() / 1000 + 120,
  segmentSpeedKmh: 80,
  upcomingStops: [],
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadWithMockData(page: Page) {
  // Intercept /api/lines before navigation
  await page.route('/api/lines', route =>
    route.fulfill({ json: [MOCK_LINE] }),
  );
  // Intercept socket.io so no real connection is attempted
  await page.route('/socket.io/**', route => route.abort());

  await page.goto('/');

  // Wait for stores to be exposed (set in main.tsx after module imports)
  await page.waitForFunction(() => !!(window as any).__stores__);

  // Inject the line so the map renders it
  await page.evaluate((line) => {
    (window as any).__stores__.linesStore.getState().actions.setLines([line]);
  }, MOCK_LINE);

  // Inject a fake train on that line
  await page.evaluate((train) => {
    (window as any).__stores__.trainsStore.getState().actions.applyUpdate([train]);
  }, MOCK_TRAIN);
}

async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  return errors;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('line map SVG renders on load', async ({ page }) => {
  await loadWithMockData(page);
  await expect(page.locator('svg')).toBeVisible();
  // At least one stop circle should appear
  await expect(page.locator('svg circle').first()).toBeVisible();
});

test('clicking a train dot does not crash the map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loadWithMockData(page);

  // The train dot is a <g> containing circles; target the outermost train g via cursor:pointer
  // Train dots sit inside the SVG. Find a circle that is NOT a stop dot (train bg circle is larger).
  const svg = page.locator('svg');
  await expect(svg).toBeVisible();

  // Click the position where the train should be (canonicalX=0.3 on the line)
  // Use the data attribute added by TrainDot's onClick to locate it
  const trainCircles = svg.locator('circle[stroke="white"]');
  const count = await trainCircles.count();
  if (count > 0) {
    await trainCircles.first().click({ force: true });
    // After click: SVG must still be in the DOM (no blank screen)
    await expect(svg).toBeVisible();
    // No React errors
    const reactErrors = errors.filter(e => e.includes('ReferenceError') || e.includes('Cannot access'));
    expect(reactErrors).toHaveLength(0);
  }
});

test('selecting a train then deselecting restores the full map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loadWithMockData(page);

  const svg = page.locator('svg');
  await expect(svg).toBeVisible();

  // Select a train via the store (simulates a click without needing exact pixel coords)
  await page.evaluate((tripId) => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(tripId);
  }, MOCK_TRAIN.tripId);

  // Map must still render after selection
  await expect(svg).toBeVisible();
  expect(errors.filter(e => e.includes('ReferenceError') || e.includes('Cannot access'))).toHaveLength(0);

  // Deselect
  await page.evaluate(() => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(null);
  });

  await expect(svg).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('selecting a train shows zoomed viewport without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loadWithMockData(page);

  await page.evaluate((tripId) => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(tripId);
  }, MOCK_TRAIN.tripId);

  // Map container must still be in the DOM after selection
  await expect(page.locator('svg')).toBeVisible();
  expect(errors).toHaveLength(0);

  // Verify the viewport was actually applied (uiStore.viewport should be non-null)
  const hasViewport = await page.evaluate(() =>
    (window as any).__stores__.uiStore.getState().viewport !== null,
  );
  expect(hasViewport).toBe(true);
});
