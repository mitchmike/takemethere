import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    // Capture console errors so tests can assert on them
    ...devices['Desktop Chrome'],
  },
  webServer: {
    // Always start on 5174 so it doesn't clash with the dev server the user
    // typically keeps running on 5173.
    command: 'vite --port 5174',
    port: 5174,
    // Never reuse an existing server — we want a clean isolated instance.
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
