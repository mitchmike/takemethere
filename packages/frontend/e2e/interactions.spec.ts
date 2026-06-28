import { test, expect, type Page } from '@playwright/test';

// ── Shared mock data ───────────────────────────────────────────────────────

const MOCK_LINE_BELGRAVE = {
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

const MOCK_LINE_ALAMEIN = {
  lineId: 'alamein',
  name: 'Alamein',
  color: '#094C8D',
  stops: [
    { lineId: 'alamein', stopId: 'a1', stopName: 'Flinders Street Station', canonicalX: 0,   canonicalPosition: 1, stopLat: -37.818, stopLon: 144.967 },
    { lineId: 'alamein', stopId: 'a2', stopName: 'Richmond Station',        canonicalX: 0.1, canonicalPosition: 2, stopLat: -37.824, stopLon: 144.990 },
    { lineId: 'alamein', stopId: 'a3', stopName: 'Camberwell Station',      canonicalX: 0.5, canonicalPosition: 3, stopLat: -37.824, stopLon: 145.060 },
    { lineId: 'alamein', stopId: 'a4', stopName: 'Alamein Station',         canonicalX: 0.7, canonicalPosition: 4, stopLat: -37.866, stopLon: 145.093 },
  ],
};

const MOCK_TRAIN_OUTBOUND = {
  tripId: 'trip-out',
  lineId: 'belgrave',
  lat: -37.824, lon: 145.02, bearing: 90,
  timestamp: Date.now() / 1000 - 5,
  canonicalX: 0.3, delay: 0, directionId: 0,
  prevStopId: 's2', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
  nextStopId: 's3', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
  scheduledNextArrivalEpoch: Date.now() / 1000 + 120,
  nextArrivalEpoch: Date.now() / 1000 + 120,
  predictedNextArrivalEpoch: Date.now() / 1000 + 120,
  segmentSpeedKmh: 80, upcomingStops: [],
};

const MOCK_TRAIN_INBOUND = {
  ...MOCK_TRAIN_OUTBOUND,
  tripId: 'trip-in',
  directionId: 1,
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function setup(page: Page, lines = [MOCK_LINE_BELGRAVE]) {
  await page.route('/api/lines', route => route.fulfill({ json: lines }));
  await page.route('/socket.io/**', route => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__stores__);
  await page.evaluate((ls) => {
    (window as any).__stores__.linesStore.getState().actions.setLines(ls);
  }, lines);
}

async function injectTrain(page: Page, train: object) {
  await page.evaluate((t) => {
    (window as any).__stores__.trainsStore.getState().actions.applyUpdate([t]);
  }, train);
}

async function pageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

// ── Direction filter ───────────────────────────────────────────────────────

test('direction filter — toggling to Outbound removes inbound train dot', async ({ page }) => {
  const errors = await pageErrors(page);
  await setup(page);
  await injectTrain(page, MOCK_TRAIN_OUTBOUND);
  await injectTrain(page, MOCK_TRAIN_INBOUND);

  // Count train dots (white-stroked circles = train background)
  const before = await page.locator('svg circle[stroke="white"]').count();
  expect(before).toBeGreaterThanOrEqual(2); // at least both trains

  // Switch to Outbound only
  await page.getByRole('button', { name: 'Outbound' }).click();

  const after = await page.locator('svg circle[stroke="white"]').count();
  expect(after).toBeLessThan(before);
  expect(errors).toHaveLength(0);
});

test('direction filter — toggling back to Both directions restores train dots', async ({ page }) => {
  await setup(page);
  await injectTrain(page, MOCK_TRAIN_OUTBOUND);
  await injectTrain(page, MOCK_TRAIN_INBOUND);

  await page.getByRole('button', { name: 'Outbound' }).click();
  await page.getByRole('button', { name: 'Both directions' }).click();

  const count = await page.locator('svg circle[stroke="white"]').count();
  expect(count).toBeGreaterThanOrEqual(2);
});

// ── Line filter ────────────────────────────────────────────────────────────

test('line filter — deselecting a line removes it from the SVG', async ({ page }) => {
  await setup(page, [MOCK_LINE_BELGRAVE, MOCK_LINE_ALAMEIN]);

  // Both lines should be visible — count their stop circles (each line: 4 stops)
  const before = await page.locator('svg circle').count();
  expect(before).toBeGreaterThan(4); // at least 8 stop circles

  // Toggle Belgrave off via the chip button
  await page.getByRole('button', { name: 'Belgrave' }).click();

  const after = await page.locator('svg circle').count();
  expect(after).toBeLessThan(before);
});

test('line filter — "None" button clears all lines', async ({ page }) => {
  const errors = await pageErrors(page);
  await setup(page, [MOCK_LINE_BELGRAVE, MOCK_LINE_ALAMEIN]);

  await page.getByRole('button', { name: 'None' }).click();

  // No stop circles when no lines are selected
  const circles = await page.locator('svg circle').count();
  expect(circles).toBe(0);
  expect(errors).toHaveLength(0);
});

test('line filter — "All" button restores all lines', async ({ page }) => {
  await setup(page, [MOCK_LINE_BELGRAVE, MOCK_LINE_ALAMEIN]);
  await page.getByRole('button', { name: 'None' }).click();
  await page.getByRole('button', { name: 'All' }).click();

  const circles = await page.locator('svg circle').count();
  expect(circles).toBeGreaterThan(4);
});

// ── Layout toggle ─────────────────────────────────────────────────────────

test('layout toggle — switching to Vertical keeps SVG visible without errors', async ({ page }) => {
  const errors = await pageErrors(page);
  await setup(page);

  await page.getByRole('button', { name: 'Vertical' }).click();
  await expect(page.locator('svg')).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('layout toggle — switching Vertical → Horizontal keeps SVG visible', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Vertical' }).click();
  await page.getByRole('button', { name: 'Horizontal' }).click();
  await expect(page.locator('svg')).toBeVisible();
});

// ── Stop click ────────────────────────────────────────────────────────────

test('clicking a stop circle updates the uiStore selectedStopName', async ({ page }) => {
  await setup(page);

  // Clicks the first stop circle (Flinders Street, cx=0 → LEFT_MARGIN)
  await page.locator('svg circle').first().click({ force: true });

  const stopName = await page.evaluate(() =>
    (window as any).__stores__.uiStore.getState().selectedStopName,
  );
  // After clicking a stop, selectedStopName should be non-null
  expect(stopName).toBeTruthy();
});

test('clicking a selected stop circle deselects it', async ({ page }) => {
  await setup(page);

  // Select first stop
  await page.locator('svg circle').first().click({ force: true });
  const first = await page.evaluate(() =>
    (window as any).__stores__.uiStore.getState().selectedStopName,
  );
  expect(first).toBeTruthy();

  // Click again to deselect
  await page.locator('svg circle').first().click({ force: true });
  const second = await page.evaluate(() =>
    (window as any).__stores__.uiStore.getState().selectedStopName,
  );
  expect(second).toBeNull();
});

// ── Train selection + viewport ─────────────────────────────────────────────

test('selecting a train via the store sets a viewport', async ({ page }) => {
  await setup(page);
  await injectTrain(page, MOCK_TRAIN_OUTBOUND);

  await page.evaluate((tripId) => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(tripId);
  }, MOCK_TRAIN_OUTBOUND.tripId);

  const viewport = await page.evaluate(() =>
    (window as any).__stores__.uiStore.getState().viewport,
  );
  expect(viewport).not.toBeNull();
  expect(typeof viewport.center).toBe('number');
  expect(typeof viewport.windowHalf).toBe('number');
  expect(viewport.windowHalf).toBeGreaterThan(0);
});

test('deselecting a train clears the viewport', async ({ page }) => {
  await setup(page);
  await injectTrain(page, MOCK_TRAIN_OUTBOUND);

  await page.evaluate((tripId) => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(tripId);
  }, MOCK_TRAIN_OUTBOUND.tripId);

  await page.evaluate(() => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(null);
  });

  const viewport = await page.evaluate(() =>
    (window as any).__stores__.uiStore.getState().viewport,
  );
  expect(viewport).toBeNull();
});

// ── Vertical layout + train selection (scroll bug regression) ──────────────

test('selecting a train in vertical layout does not crash or blank the SVG', async ({ page }) => {
  const errors = await pageErrors(page);
  await setup(page, [MOCK_LINE_BELGRAVE, MOCK_LINE_ALAMEIN]);
  await injectTrain(page, MOCK_TRAIN_OUTBOUND);

  // Switch to vertical first
  await page.getByRole('button', { name: 'Vertical' }).click();

  // Select a train (this previously caused the SVG width to collapse)
  await page.evaluate((tripId) => {
    (window as any).__stores__.uiStore.getState().actions.selectTrip(tripId);
  }, MOCK_TRAIN_OUTBOUND.tripId);

  await expect(page.locator('svg')).toBeVisible();

  // Both lines should still be showing (vertical mode doesn't filter by viewport)
  const circles = await page.locator('svg circle').count();
  expect(circles).toBeGreaterThan(4); // both Belgrave + Alamein stop circles present
  expect(errors).toHaveLength(0);
});
