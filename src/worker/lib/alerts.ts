import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { maybeSendBudgetAlerts } from '../push/notify';

/**
 * Budget alerts run after the response. They are best effort: a missing ExecutionContext (e.g.
 * app.request without one) or any failure in the push code must never fail the write itself.
 */
export function queueBudgetAlerts(c: Context<AppEnv>, occurredAt: string): void {
  try {
    const ctx = c.executionCtx;
    ctx.waitUntil(maybeSendBudgetAlerts(c.env, c.var.user.id, occurredAt).catch((err: unknown) => console.error('Budget alerts failed', err)));
  } catch (err) {
    console.error('Budget alerts not queued', err);
  }
}

/**
 * The latest occurred_at of each month a batch touches. An alert is about one month's total, so a
 * batch that mixes this month with a future-dated entry must still check this month.
 */
export function latestPerMonth(occurredAts: readonly string[]): string[] {
  const byMonth = new Map<string, string>();
  for (const at of occurredAts) {
    const month = at.slice(0, 7);
    const latest = byMonth.get(month);
    if (latest === undefined || at > latest) byMonth.set(month, at);
  }
  return [...byMonth.values()];
}

/** Alerts for every month a set of new or changed entries touches. */
export function queueAlertsFor(c: Context<AppEnv>, occurredAts: readonly string[]): void {
  for (const at of latestPerMonth(occurredAts)) queueBudgetAlerts(c, at);
}
