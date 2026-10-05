import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

// Fixed VAPID pair for tests only (never used in production).
const TEST_VAPID = {
  VAPID_PUBLIC_KEY: 'BJ9P9iXcAieB62riJYMOiKskybW6xbYDMAuZHYraWeVXyTEQggXq1Do7ULYJRsUKv16InFII5M_TxYb05974iGI',
  VAPID_PRIVATE_KEY: '9S-jzXSVB5AlWjyA0o4A_qNOgkzqyt8O7_oA7zbk9dY',
  VAPID_SUBJECT: 'mailto:tests@tally.test',
};

const alias = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));
  const common = (bindings: Record<string, unknown>) =>
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, ...TEST_VAPID, ...bindings } },
    });
  return {
    resolve: { alias },
    test: {
      projects: [
        {
          resolve: { alias },
          plugins: [common({})],
          test: {
            name: 'worker',
            include: ['tests/worker/**/*.test.ts'],
            setupFiles: ['tests/worker/setup.ts'],
          },
        },
        {
          resolve: { alias },
          plugins: [common({ INVITE_CODE: 'letmein', SIGNUPS_ENABLED: 'true' })],
          test: {
            name: 'worker-gated',
            include: ['tests/worker-gated/**/*.test.ts'],
            setupFiles: ['tests/worker/setup.ts'],
          },
        },
        {
          resolve: { alias },
          plugins: [common({ SIGNUPS_ENABLED: 'false' })],
          test: {
            name: 'worker-closed',
            include: ['tests/worker-closed/**/*.test.ts'],
            setupFiles: ['tests/worker/setup.ts'],
          },
        },
      ],
    },
  };
});
