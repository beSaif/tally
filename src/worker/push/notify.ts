/**
 * Composing and delivering notifications: one payload per device language, delivery
 * bookkeeping (failure counts, cleanup of dead subscriptions), dedup through
 * notification_log, and the budget alert hook (docs/SPEC.md §8.3–8.4).
 */
import type { PushKind, PushPayload, ResolvedLanguage } from '@shared/api';
import { BUDGET_THRESHOLDS } from '@shared/constants';
import { addDays, daysLeftInMonth, monthRange, zonedParts } from '@shared/dates';
import type { Env } from '../env';
import { loadSettingsRow, nowMs } from '../lib/db';
import { budgetText } from './strings';
import { sendWebPush, vapidFromEnv, type SendOptions, type SendResult, type Vapid } from './webpush';

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

/**
 * Records that a notification is going out. Returns false when it already went out for this
 * period (or another run is sending it right now), in which case the caller must not send.
 */
export async function claimNotification(env: Env, userId: string, kind: Exclude<PushKind, 'test'>, periodKey: string): Promise<boolean> {
  const res = await env.DB.prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, period_key, sent_at) VALUES (?, ?, ?, ?)')
    .bind(userId, kind, periodKey, nowMs())
    .run();
  return res.meta.changes > 0;
}

/**
 * Sends a payload, localised per device, to each subscription and records the outcome:
 * success resets the failure count, 404/410 deletes the subscription, any other failure counts
 * towards MAX_FAILURES consecutive failures. Returns how many devices accepted the message.
 */
export async function sendToSubscriptions(
  env: Env,
  subs: readonly SubscriptionRow[],
  payloadFor: (lang: ResolvedLanguage) => PushPayload,
  vapid?: Vapid,
): Promise<number> {
  if (subs.length === 0) return 0;
  const keys = vapid ?? (await vapidFromEnv(env));
  if (!keys) {
    console.error('Push is not configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); nothing sent');
    return 0;
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
        return await sendWebPush(sub, payload, keys, deliveryOptions(payload.kind));
      } catch (err) {
        // Malformed keys or a network error: count it like any other failed delivery.
        console.error(`Push delivery to subscription ${sub.id} failed`, err);
        return { ok: false, status: 0, gone: false };
      }
    }),
  );

  const now = nowMs();
  const writes: D1PreparedStatement[] = [];
  let sent = 0;
  results.forEach((result, i) => {
    const sub = subs[i];
    if (!sub) return;
    if (result.ok) {
      sent++;
      writes.push(env.DB.prepare('UPDATE push_subscriptions SET failures = 0, last_seen_at = ? WHERE id = ?').bind(now, sub.id));
    } else if (result.gone) {
      writes.push(env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id));
    } else {
      writes.push(env.DB.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').bind(sub.id));
      writes.push(env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?').bind(sub.id, MAX_FAILURES));
    }
  });
  if (writes.length) await env.DB.batch(writes);
  return sent;
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

  const range = monthRange(today);
  const row = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM entries WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?')
    .bind(userId, range.from, addDays(range.to, 1))
    .first<{ total: number }>();
  const total = row?.total ?? 0;
  const crossed = BUDGET_THRESHOLDS.filter((t) => total * 100 >= t * budget);
  if (crossed.length === 0) return 0;

  const sentAt = nowMs();
  const inserted = await env.DB.batch(
    crossed.map((t) =>
      env.DB.prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, period_key, sent_at) VALUES (?, ?, ?, ?)').bind(userId, 'budget', `${month}:${t}`, sentAt),
    ),
  );
  const fresh = crossed.filter((_, i) => (inserted[i]?.meta.changes ?? 0) > 0);
  if (fresh.length === 0) return 0;
  const threshold = Math.max(...fresh);

  const daysLeft = daysLeftInMonth(today);
  return sendToSubscriptions(env, subs, (lang) => ({
    kind: 'budget',
    ...budgetText(lang, { threshold, spentCents: total, budgetCents: budget, currency: settings.currency, daysLeft }),
    url: '/overview?p=month',
    tag: 'budget',
    lang,
  }));
}
