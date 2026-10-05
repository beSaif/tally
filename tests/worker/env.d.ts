import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      VAPID_PUBLIC_KEY: string;
      VAPID_PRIVATE_KEY: string;
      VAPID_SUBJECT: string;
      INVITE_CODE?: string;
      SIGNUPS_ENABLED?: string;
    }
  }
}
export {};
