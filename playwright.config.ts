import { defineConfig, devices } from '@playwright/test';

/**
 * Two projects:
 * - `e2e`    real Worker API (wrangler dev on E2E_PORT, default 8787) + mocked Gemini + fake push.
 * - `visual` the Vite dev server on E2E_VISUAL_PORT (default 5174) with the API mocked in the
 *            browser (e2e/support/mock-api.ts); screenshots go to e2e/__screenshots__/.
 * Run one with `npx playwright test --project=visual`. A server already listening is reused.
 */
const PORT = Number(process.env.E2E_PORT ?? 8787);
const VISUAL_PORT = Number(process.env.E2E_VISUAL_PORT ?? 5174);
const apiURL = `http://127.0.0.1:${PORT}`;
const visualURL = `http://127.0.0.1:${VISUAL_PORT}`;

const phone = {
  ...devices['Pixel 7'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    ...phone,
    locale: 'en-CH',
    timezoneId: 'Europe/Zurich',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      // A fake microphone, so a real Recorder works headless.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    },
  },
  projects: [
    { name: 'e2e', testIgnore: /\.mock\.spec\.ts$/, use: { ...phone, baseURL: apiURL } },
    { name: 'visual', testMatch: /\.mock\.spec\.ts$/, use: { ...phone, baseURL: visualURL } },
  ],
  webServer: [
    {
      command: `npm run build && npm run db:migrate:local && npx wrangler dev --port ${PORT} --test-scheduled`,
      url: `${apiURL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npx vite --config e2e/support/vite.visual.config.ts --port ${VISUAL_PORT} --strictPort --host 127.0.0.1`,
      url: visualURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
