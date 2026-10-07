import { defineConfig, devices } from '@playwright/test';
import { FAKE_GOOGLE_CLIENT_ID, FAKE_GOOGLE_PORT } from './e2e/support/fake-google';

/**
 * End-to-end tests against the real Worker API: `wrangler dev` serving the built app on E2E_PORT
 * (default 8787), with Gemini mocked per test (e2e/support/mock-gemini.ts), a stand-in Google for
 * sign-in (e2e/support/fake-google.ts, on E2E_GOOGLE_PORT) and a fake push service
 * (e2e/support/fake-push.ts + push-sink.ts). Screenshots of every screen and state go to
 * e2e/__screenshots__/ (390×844 @2x). A server already listening on E2E_PORT is reused locally;
 * it must serve a fresh `npm run build` and have been started with the same `--var` flags.
 * `--local-upstream` keeps requests under 127.0.0.1: wrangler dev otherwise presents them under the
 * custom-domain route in wrangler.jsonc, and the Worker builds the Google callback from that host.
 */
const PORT = Number(process.env.E2E_PORT ?? 8787);
const baseURL = `http://127.0.0.1:${PORT}`;
const GOOGLE_VARS = [
  `GOOGLE_CLIENT_ID:${FAKE_GOOGLE_CLIENT_ID}`,
  'GOOGLE_CLIENT_SECRET:tally-e2e-secret',
  `GOOGLE_AUTH_URL:http://127.0.0.1:${FAKE_GOOGLE_PORT}/authorize`,
  `GOOGLE_TOKEN_URL:http://127.0.0.1:${FAKE_GOOGLE_PORT}/token`,
]
  .map((v) => `--var ${v}`)
  .join(' ');

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    baseURL,
    locale: 'en-CH',
    timezoneId: 'Europe/Zurich',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      // A fake microphone (a beeping tone), so the real Recorder works headless.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    },
  },
  projects: [{ name: 'e2e' }],
  webServer: {
    command: `npm run vapid && npm run build && npm run db:migrate:local && npx wrangler dev --port ${PORT} --test-scheduled --local-upstream 127.0.0.1:${PORT} ${GOOGLE_VARS}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
