import type { Env } from '../env';

/**
 * Budget alert hook, called by the entries routes after a create/update (inside ctx.waitUntil).
 * TODO(push-agent): implement per docs/SPEC.md §8.4. Must never throw.
 */
export async function maybeSendBudgetAlerts(_env: Env, _userId: string, _occurredAt: string): Promise<void> {
  // stub
}
