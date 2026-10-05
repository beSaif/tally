/**
 * Cron handler (every 15 minutes, docs/SPEC.md §8.4): daily reminders, the Monday summary and
 * the monthly report, each evaluated in the local time of the user's devices.
 */
import type { PushPayload, ResolvedLanguage } from '@shared/api';
import { CRON_SLOT_MINUTES, MONTHLY_HOUR, WEEKLY_HOUR } from '@shared/constants';
import { addDays, addMonths, floorToSlot, isoWeekKey, monthRange, zonedParts, type DayRange } from '@shared/dates';
import type { Env } from '../env';
import type { SettingsRow } from '../lib/db';
import { claimNotification, safeTimeZone, sendToSubscriptions, type SubscriptionRow } from './notify';
import { monthlyText, reminderText, weeklyText, type TopCategory } from './strings';
import { vapidFromEnv, type Vapid } from './webpush';

type ScheduledKind = 'reminder' | 'weekly' | 'monthly';

/** A notification that is due in this run, and the devices whose local time made it due. */
interface Due {
  kind: ScheduledKind;
  periodKey: string;
  /** The devices' local day. */
  day: string;
  subs: SubscriptionRow[];
}

interface PeriodStats {
  totalCents: number;
  count: number;
  top: TopCategory;
}

export async function runScheduled(env: Env, now: Date): Promise<void> {
  let vapid: Vapid | null;
  try {
    vapid = await vapidFromEnv(env);
  } catch (err) {
    console.error('VAPID keys are malformed; scheduled notifications skipped', err);
    return;
  }
  if (!vapid) {
    console.warn('VAPID keys are not configured; scheduled notifications skipped');
    return;
  }

  let subscribers: Subscriber[];
  try {
    subscribers = await loadSubscribers(env);
  } catch (err) {
    console.error('Scheduled notifications: could not list subscribers', err);
    return;
  }

  // Everyone in a zone shares the local time of this run, and Intl formatters are not free.
  const zoneTimes = new Map<string, ZoneTime>();
  const zoneTime = (tz: string): ZoneTime => {
    let t = zoneTimes.get(tz);
    if (!t) {
      const zone = safeTimeZone(tz);
      zoneTimes.set(tz, (t = { zone, local: zonedParts(now, zone) }));
    }
    return t;
  };

  for (const { settings, subs } of subscribers) {
    try {
      await runForUser(env, settings, subs, zoneTime, vapid);
    } catch (err) {
      console.error(`Scheduled notifications failed for user ${settings.user_id}`, err);
    }
  }
}

type LocalTime = ReturnType<typeof zonedParts>;

/** A device zone as the runtime understands it, and its local time in this run. */
interface ZoneTime {
  zone: string;
  local: LocalTime;
}

interface Subscriber {
  settings: SettingsRow;
  /** Most recently seen first. */
  subs: SubscriptionRow[];
}

/**
 * Every user with a device and at least one scheduled notification turned on, with their
 * devices. Two queries for the whole run, not two per user: D1 caps the queries of one
 * invocation (50 on the Workers Free plan), and most runs have nothing due for most users.
 */
async function loadSubscribers(env: Env): Promise<Subscriber[]> {
  const [settingsRes, subsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM settings
        WHERE (notif_reminder = 1 OR notif_weekly = 1 OR notif_monthly = 1)
          AND user_id IN (SELECT user_id FROM push_subscriptions)`,
    ),
    env.DB.prepare(
      `SELECT p.* FROM push_subscriptions p JOIN settings s ON s.user_id = p.user_id
        WHERE s.notif_reminder = 1 OR s.notif_weekly = 1 OR s.notif_monthly = 1
        ORDER BY p.user_id, p.last_seen_at DESC, p.created_at DESC`,
    ),
  ]);
  const byUser = new Map<string, Subscriber>();
  // batch() takes one row type for all its statements, hence the casts.
  for (const settings of (settingsRes?.results ?? []) as SettingsRow[]) byUser.set(settings.user_id, { settings, subs: [] });
  for (const sub of (subsRes?.results ?? []) as SubscriptionRow[]) byUser.get(sub.user_id)?.subs.push(sub);
  return [...byUser.values()].filter((s) => s.subs.length > 0);
}

async function runForUser(
  env: Env,
  settings: SettingsRow,
  subs: readonly SubscriptionRow[],
  zoneTime: (tz: string) => ZoneTime,
  vapid: Vapid,
): Promise<void> {
  const reminderSlot = floorToSlot(settings.notif_reminder_time, CRON_SLOT_MINUTES);

  const zones = new Map<string, { local: LocalTime; subs: SubscriptionRow[] }>();
  for (const sub of subs) {
    const { zone, local } = zoneTime(sub.tz);
    const group = zones.get(zone);
    if (group) group.subs.push(sub);
    else zones.set(zone, { local, subs: [sub] });
  }

  // Zones that are due with the same period key share one dedup row and one send, so two
  // devices whose zones differ only in name ('Europe/Zurich', 'Europe/Berlin') both get it.
  const due = new Map<string, Due>();
  const add = (kind: ScheduledKind, periodKey: string, day: string, group: SubscriptionRow[]) => {
    const key = `${kind}|${periodKey}`;
    const existing = due.get(key);
    if (existing) existing.subs.push(...group);
    else due.set(key, { kind, periodKey, day, subs: [...group] });
  };

  for (const { local, subs: group } of zones.values()) {
    const slot = floorToSlot(local.hhmm, CRON_SLOT_MINUTES);
    if (settings.notif_reminder === 1 && slot === reminderSlot) add('reminder', local.day, local.day, group);
    if (settings.notif_weekly === 1 && local.weekday === 1 && slot === WEEKLY_HOUR) add('weekly', isoWeekKey(addDays(local.day, -7)), local.day, group);
    if (settings.notif_monthly === 1 && local.date === 1 && slot === MONTHLY_HOUR) add('monthly', addMonths(local.day, -1).slice(0, 7), local.day, group);
  }

  for (const item of due.values()) {
    try {
      if (item.kind === 'reminder') await sendReminder(env, settings, item, vapid);
      else if (item.kind === 'weekly') await sendWeekly(env, settings, item, vapid);
      else await sendMonthly(env, settings, item, vapid);
    } catch (err) {
      console.error(`Scheduled ${item.kind} failed for user ${settings.user_id}`, err);
    }
  }
}

async function sendReminder(env: Env, settings: SettingsRow, item: Due, vapid: Vapid): Promise<void> {
  const userId = settings.user_id;
  const day = item.day;
  const state = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM reminder_skips WHERE user_id = ?1 AND day = ?2) AS skipped,
            EXISTS (SELECT 1 FROM entries WHERE user_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3) AS logged`,
  )
    .bind(userId, day, addDays(day, 1))
    .first<{ skipped: number; logged: number }>();
  if (state?.skipped) return;
  if (settings.notif_reminder_only_if_empty === 1 && state?.logged) return;
  if (!(await claimNotification(env, userId, 'reminder', item.periodKey))) return;
  await sendToSubscriptions(
    env,
    item.subs,
    (lang): PushPayload => {
      const t = reminderText(lang);
      return {
        kind: 'reminder',
        title: t.title,
        body: t.body,
        url: '/?compose=1',
        tag: 'reminder',
        lang,
        day,
        actions: [
          { action: 'log', title: t.log },
          { action: 'skip', title: t.skip },
        ],
      };
    },
    vapid,
  );
}

async function sendWeekly(env: Env, settings: SettingsRow, item: Due, vapid: Vapid): Promise<void> {
  const userId = settings.user_id;
  // Run on a Monday: last week is the Monday–Sunday that ended yesterday.
  const lastWeek: DayRange = { from: addDays(item.day, -7), to: addDays(item.day, -1) };
  const stats = await periodStats(env, userId, lastWeek);
  if (stats.count === 0) return;
  const previousTotalCents = await periodTotal(env, userId, { from: addDays(item.day, -14), to: addDays(item.day, -8) });
  if (!(await claimNotification(env, userId, 'weekly', item.periodKey))) return;
  await sendToSubscriptions(
    env,
    item.subs,
    (lang: ResolvedLanguage): PushPayload => ({
      kind: 'weekly',
      ...weeklyText(lang, { totalCents: stats.totalCents, currency: settings.currency, count: stats.count, top: stats.top, previousTotalCents }),
      url: '/overview?p=week',
      tag: 'weekly',
      lang,
    }),
    vapid,
  );
}

async function sendMonthly(env: Env, settings: SettingsRow, item: Due, vapid: Vapid): Promise<void> {
  const userId = settings.user_id;
  const lastMonth = monthRange(addMonths(item.day, -1));
  const stats = await periodStats(env, userId, lastMonth);
  if (stats.count === 0) return;
  if (!(await claimNotification(env, userId, 'monthly', item.periodKey))) return;
  const month = Number(lastMonth.from.slice(5, 7));
  await sendToSubscriptions(
    env,
    item.subs,
    (lang: ResolvedLanguage): PushPayload => ({
      kind: 'monthly',
      ...monthlyText(lang, {
        month,
        totalCents: stats.totalCents,
        currency: settings.currency,
        count: stats.count,
        top: stats.top,
        budgetCents: settings.budget_cents,
      }),
      url: '/overview?p=month',
      tag: 'monthly',
      lang,
    }),
    vapid,
  );
}

/** Totals for an inclusive day range, and the category that led it. */
async function periodStats(env: Env, userId: string, range: DayRange): Promise<PeriodStats> {
  const { results } = await env.DB.prepare(
    `SELECT c.name AS name, SUM(e.amount_cents) AS total_cents, COUNT(*) AS count
       FROM entries e LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at < ?
      GROUP BY e.category_id
      ORDER BY total_cents DESC, count DESC, name`,
  )
    .bind(userId, range.from, addDays(range.to, 1))
    .all<{ name: string | null; total_cents: number; count: number }>();
  const first = results[0];
  return {
    totalCents: results.reduce((n, r) => n + r.total_cents, 0),
    count: results.reduce((n, r) => n + r.count, 0),
    top: { name: first?.name ?? null, totalCents: first?.total_cents ?? 0 },
  };
}

async function periodTotal(env: Env, userId: string, range: DayRange): Promise<number> {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM entries WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?')
    .bind(userId, range.from, addDays(range.to, 1))
    .first<{ total: number }>();
  return row?.total ?? 0;
}
