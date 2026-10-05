/**
 * Composing and delivering notifications: one payload per device language, delivery
 * bookkeeping (failure counts, cleanup of dead subscriptions), dedup through
 * notification_log, and the budget alert hook (docs/SPEC.md §8.3–8.4).
 */
import type { PushKind, PushPayload, ResolvedLanguage } from '@shared/api';
import { BUDGET_THRESHOLDS } from '@shared/constants';
import { daysLeftInMonth, monthRange, zonedParts } from '@shared/dates';
import type { Env } from '../env';
import { loadSettingsRow, nowMs } from '../lib/db';
import { occurredBounds } from '../lib/range';
import { budgetText } from './strings';
import { sendWebPush, vapidFromEnv, type SendOptions, type SendResult, type Vapid, type VapidCache } from './webpush';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  lang: ResolvedLanguage;
  tz: string;
  created_at: number;
  last_seen_at: number;
  failures: number;
}

/** Consecutive failed deliveries after which a subscription is dropped. */
export const MAX_FAILURES = 5;

/** Reminders and tests are stale within the hour; summaries and alerts can wait a day. */
export function deliveryOptions(kind: PushKind): SendOptions {
  return {
    ttl: kind === 'reminder' || kind === 'test' ? 3600 : 86_400,
    urgency: kind === 'budget' ? 'high' : 'normal',
  };
}

/** The zone itself when the runtime knows it, else UTC (a device can report a zone we cannot use). */
export function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Most recently seen first: that device's zone stands for where the person is now. */
export async function loadSubscriptions(env: Env, userId: string): Promise<SubscriptionRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY last_seen_at DESC, created_at DESC')
    .bind(userId)
    .all<SubscriptionRow>();
  return results;
}

/** The kinds notification_log dedups; test notifications are never logged. */
export type LoggedKind = Exclude<PushKind, 'test'>;

/**
 * Records that a notification is going out. Returns false when it already went out for this
 * period (or another run is sending it right now), in which case the caller must not send.
 */
export async function claimNotification(env: Env, userId: string, kind: LoggedKind, periodKey: string, sentAt: number = nowMs()): Promise<boolean> {
  const res = await env.DB.prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, period_key, sent_at) VALUES (?, ?, ?, ?)')
    .bind(userId, kind, periodKey, sentAt)
    .run();
  return res.meta.changes > 0;
}

/**
 * Gives a claim back after a delivery that reached nobody but could still reach someone (see
 * worthRetrying), so a later attempt sends it instead of the period passing in silence.
 */
export async function releaseNotification(env: Env, userId: string, kind: LoggedKind, periodKey: string): Promise<void> {
  await env.DB.prepare('DELETE FROM notification_log WHERE user_id = ? AND kind = ? AND period_key = ?').bind(userId, kind, periodKey).run();
}

/** What became of one message to a set of devices. */
export interface Delivery {
  /** Devices that accepted it. */
  sent: number;
  /** Targeted devices still subscribed after the bookkeeping: neither gone nor dropped. */
  kept: number;
}

/**
 * Nobody accepted the message, yet a device that might later is still subscribed: a transient
 * failure, worth another try. When every device is gone, a retry would reach no one.
 */
export const worthRetrying = (delivery: Delivery): boolean => delivery.sent === 0 && delivery.kept > 0;

const idList = (subs: readonly SubscriptionRow[]): string => JSON.stringify(subs.map((s) => s.id));

/**
 * Sends a payload, localised per device, to each subscription and records the outcome:
 * success resets the failure count, 404/410 deletes the subscription, any other failure counts
 * towards MAX_FAILURES consecutive failures. Pass the run's `cache` so VAPID tokens are signed
 * once per push service.
 */
export async function sendToSubscriptions(
  env: Env,
  subs: readonly SubscriptionRow[],
  payloadFor: (lang: ResolvedLanguage) => PushPayload,
  vapid?: Vapid,
  cache: VapidCache = new Map(),
): Promise<Delivery> {
  if (subs.length === 0) return { sent: 0, kept: 0 };
  const keys = vapid ?? (await vapidFromEnv(env));
  if (!keys) {
    console.error('Push is not configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); nothing sent');
    return { sent: 0, kept: subs.length };
  }
  const payloads = new Map<ResolvedLanguage, PushPayload>();
  const payloadIn = (lang: ResolvedLanguage): PushPayload => {
    let p = payloads.get(lang);
    if (!p) payloads.set(lang, (p = payloadFor(lang)));
    return p;
  };

  const results = await Promise.all(
    subs.map(async (sub): Promise<SendResult> => {
      const payload = payloadIn(sub.lang === 'fr' ? 'fr' : 'en');
      try {
        return await sendWebPush(sub, payload, keys, deliveryOptions(payload.kind), cache);
      } catch (err) {
        // Malformed keys or a network error: count it like any other failed delivery.
        console.error(`Push delivery to subscription ${sub.id} failed`, err);
        return { ok: false, status: 0, gone: false };
      }
    }),
  );

  const accepted: SubscriptionRow[] = [];
  const gone: SubscriptionRow[] = [];
  const failed: SubscriptionRow[] = [];
  results.forEach((result, i) => {
    const sub = subs[i];
    if (sub) (result.ok ? accepted : result.gone ? gone : failed).push(sub);
  });

  // One statement per outcome however many devices: a cron run has a D1 query budget. An
  // accepted message is no sign anyone uses the device, so last_seen_at stays (only /subscribe
  // moves it), and a device already at zero failures needs no write at all.
  const writes: D1PreparedStatement[] = [];
  const recovered = accepted.filter((s) => s.failures > 0);
  if (recovered.length) {
    writes.push(env.DB.prepare('UPDATE push_subscriptions SET failures = 0 WHERE id IN (SELECT value FROM json_each(?))').bind(idList(recovered)));
  }
  if (gone.length) writes.push(env.DB.prepare('DELETE FROM push_subscriptions WHERE id IN (SELECT value FROM json_each(?))').bind(idList(gone)));
  let dropAt = -1;
  if (failed.length) {
    writes.push(env.DB.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id IN (SELECT value FROM json_each(?))').bind(idList(failed)));
    dropAt = writes.length;
    writes.push(
      env.DB.prepare('DELETE FROM push_subscriptions WHERE failures >= ? AND id IN (SELECT value FROM json_each(?))').bind(MAX_FAILURES, idList(failed)),
    );
  }
  const written = writes.length ? await env.DB.batch(writes) : [];
  const dropped = dropAt >= 0 ? (written[dropAt]?.meta.changes ?? 0) : 0;
  return { sent: accepted.length, kept: subs.length - gone.length - dropped };
}

/**
 * Budget alert hook, called by the entries routes after a create/update (inside
 * ctx.waitUntil). Never throws: an alert is not worth failing anything for.
 */
export async function maybeSendBudgetAlerts(env: Env, userId: string, occurredAt: string): Promise<void> {
  try {
    await runBudgetAlerts(env, userId, occurredAt, new Date());
  } catch (err) {
    console.error('Budget alert failed', err);
  }
}

/**
 * The budget alert logic with an injectable clock (tests). Logs every threshold the month's
 * total has crossed and notifies about the highest one not logged before.
 * Returns the number of devices notified.
 */
export async function runBudgetAlerts(env: Env, userId: string, occurredAt: string, now: Date): Promise<number> {
  const settings = await loadSettingsRow(env, userId);
  const budget = settings?.budget_cents ?? 0;
  if (!settings || settings.notif_budget !== 1 || budget <= 0) return 0;
  const subs = await loadSubscriptions(env, userId);
  const latest = subs[0];
  if (!latest) return 0;

  // Only entries in the current month move the needle; editing last month's entries does not.
  const today = zonedParts(now, safeTimeZone(latest.tz)).day;
  const month = today.slice(0, 7);
  if (occurredAt.slice(0, 7) !== month) return 0;

  const row = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM entries WHERE user_id = ? AND occurred_at >= ? AND occurred_at <= ?')
    .bind(userId, ...occurredBounds(monthRange(today)))
    .first<{ total: number }>();
  const total = row?.total ?? 0;
  const crossed = BUDGET_THRESHOLDS.filter((t) => total * 100 >= t * budget);
  if (crossed.length === 0) return 0;

  // Check the keys before logging, or an unconfigured server would swallow the alert for good.
  const vapid = await vapidFromEnv(env);
  if (!vapid) {
    console.error('Push is not configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); budget alert not sent');
    return 0;
  }

  const sentAt = nowMs();
  const keyOf = (threshold: number) => `${month}:${threshold}`;
  const inserted = await env.DB.batch(
    crossed.map((t) =>
      env.DB.prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, period_key, sent_at) VALUES (?, ?, ?, ?)').bind(userId, 'budget', keyOf(t), sentAt),
    ),
  );
  const fresh = crossed.filter((_, i) => (inserted[i]?.meta.changes ?? 0) > 0);
  if (fresh.length === 0) return 0;
  const threshold = Math.max(...fresh);

  const daysLeft = daysLeftInMonth(today);
  const delivery = await sendToSubscriptions(
    env,
    subs,
    (lang) => ({
      kind: 'budget',
      ...budgetText(lang, { threshold, spentCents: total, budgetCents: budget, currency: settings.currency, daysLeft }),
      url: '/overview?p=month',
      tag: 'budget',
      lang,
    }),
    vapid,
  );
  // Undo this call's claims so the next entry write tries again.
  if (worthRetrying(delivery)) await Promise.all(fresh.map((t) => releaseNotification(env, userId, 'budget', keyOf(t))));
  return delivery.sent;
}
