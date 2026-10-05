import type { Env } from '../env';

/** Cron entry point (every 15 minutes). TODO(push-agent): implement per docs/SPEC.md §8.4. */
export async function runScheduled(_env: Env, _now: Date): Promise<void> {
  // stub
}
