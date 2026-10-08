/**
 * Cron handler (every 15 minutes, docs/SPEC.md §8.4): daily reminders, the Monday summary and
 * the monthly report, each evaluated in the local time of the user's devices.
 *
 * - A kind is due for the hour that opens at its local time: the reminder from the user's own
 *   minute (never before it), the summary on Mondays and the report on the 1st from 09:00. The
 *   cron gets up to four tries, and a run picks up what an earlier one left undone.
 * - notification_log holds one claim per period and zone (`2026-10-05@Europe/Zurich`): each group
 *   of devices gets a message once, and devices elsewhere get theirs when their own hour comes.
 * - A Workers Free invocation may make 50 D1 queries. The run counts its own and, past
 *   QUERY_BUDGET, leaves the rest to the next run in the window.
 */
import type { PushPayload, ResolvedLanguage } from '@shared/api';
import { MONTHLY_HOUR, WEEKLY_HOUR } from '@shared/constants';
import { addDays, addMonths, dueDay, isoWeekKey, monthRange, weekdayOf, zonedParts, type DayRange } from '@shared/dates';
import type { Env } from '../env';
import { meteredDb, QueryMeter } from '../lib/d1-meter';
import type { SettingsRow } from '../lib/db';
import { occurredBounds } from '../lib/range';
import { claimNotification, releaseNotification, safeTimeZone, sendToSubscriptions, worthRetrying, type SubscriptionRow } from './notify';
import { monthlyText, reminderText, weeklyText, type TopCategory } from './strings';
import { vapidFromEnv, type Vapid, type VapidCache } from './webpush';

/** How long a kind stays due after its local time: four runs of the 15-minute cron. */
const DUE_WINDOW_MINUTES = 60;
/** Queries after which a run starts no new work; the rest of D1's 50 covers the work in progress. */
export const QUERY_BUDGET = 40;
/**
 * Claims this recent may belong to a window still open: one hour, two when DST repeats an hour,
 * plus slack for a late cron. Missing one only costs a query; the claim itself still dedups.
 */
const OPEN_CLAIMS_MS = 3 * 60 * 60_000;
/** Nothing reads a "skip today" row or a log row this old (budget claims last a month). */
const SKIPS_KEPT_DAYS = 60;
const LOG_KEPT_DAYS = 90;
const DAY_MS = 86_400_000;

type ScheduledKind = 'reminder' | 'weekly' | 'monthly';

/** A notification due in this run for one zone of a user's devices. */
interface Due {
  settings: SettingsRow;
  kind: ScheduledKind;
  /** The dedup key: period and zone, e.g. `2026-10-05@Europe/Zurich`, `2026-W40@America/New_York`. */
  periodKey: string;
  /** The local day the window opened on. */
  day: string;
  subs: SubscriptionRow[];
}

/** What the sends of one run share. */
interface Run {
  /** With a metered DB. */
  env: Env;
  vapid: Vapid;
  /** One VAPID signature per push service for the whole run. */
  cache: VapidCache;
  now: Date;
}

interface PeriodStats {
  totalCents: number;
  count: number;
  top: TopCategory;
}

type LocalTime = ReturnType<typeof zonedParts>;

interface Subscriber {
  settings: SettingsRow;
  /** Most recently seen first. */
  subs: SubscriptionRow[];
}

interface RunState {
  /** In user_id order, so a run that stops early leaves the same users to the next. */
  subscribers: Subscriber[];
  /** claimKey()s already logged for windows that may still be open. */
  claimed: Set<string>;
}

const claimKey = (userId: string, kind: string, periodKey: string): string => `${userId}|${kind}|${periodKey}`;

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

  const meter = new QueryMeter();
  const run: Run = { env: { ...env, DB: meteredDb(env.DB, meter) }, vapid, cache: new Map(), now };

  let state: RunState;
  try {
    state = await loadRunState(run.env, now);
  } catch (err) {
    console.error('Scheduled notifications: could not list subscribers', err);
    return;
  }
  await prune(run.env, now);

  const work = dueWork(state, now);
  for (const [i, item] of work.entries()) {
    // Checked per item, not only per user: one user with devices in many zones has many items.
    if (meter.used >= QUERY_BUDGET) {
      const deferred = new Set(work.slice(i).map((w) => w.settings.user_id)).size;
      console.warn(`Scheduled notifications: D1 query budget spent (${meter.used} queries); ${deferred} user(s) deferred to the next run`);
      return;
    }
    try {
      if (item.kind === 'reminder') await sendReminder(run, item);
      else if (item.kind === 'weekly') await sendWeekly(run, item);
      else await sendMonthly(run, item);
    } catch (err) {
      console.error(`Scheduled ${item.kind} failed for user ${item.settings.user_id}`, err);
    }
  }
}

/**
 * Every user with a device and a scheduled notification turned on, their devices, and the
 * recent claims, in one batch for the whole run: most runs have nothing due for most users, and
 * the claims let a run skip what an earlier run in the window already sent, for free.
 */
async function loadRunState(env: Env, now: Date): Promise<RunState> {
  const [settingsRes, subsRes, claimsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM settings
        WHERE (notif_reminder = 1 OR notif_weekly = 1 OR notif_monthly = 1)
          AND user_id IN (SELECT user_id FROM push_subscriptions)
        ORDER BY user_id`,
    ),
    env.DB.prepare(
      `SELECT p.* FROM push_subscriptions p JOIN settings s ON s.user_id = p.user_id
        WHERE s.notif_reminder = 1 OR s.notif_weekly = 1 OR s.notif_monthly = 1
        ORDER BY p.user_id, p.last_seen_at DESC, p.created_at DESC`,
    ),
    env.DB.prepare("SELECT user_id, kind, period_key FROM notification_log WHERE kind IN ('reminder', 'weekly', 'monthly') AND sent_at > ?").bind(
      now.getTime() - OPEN_CLAIMS_MS,
    ),
  ]);
  const byUser = new Map<string, Subscriber>();
  // batch() takes one row type for all its statements, hence the casts.
  for (const settings of (settingsRes?.results ?? []) as SettingsRow[]) byUser.set(settings.user_id, { settings, subs: [] });
  for (const sub of (subsRes?.results ?? []) as SubscriptionRow[]) byUser.get(sub.user_id)?.subs.push(sub);
  const claims = (claimsRes?.results ?? []) as Array<{ user_id: string; kind: string; period_key: string }>;
  return {
    subscribers: [...byUser.values()].filter((s) => s.subs.length > 0),
    claimed: new Set(claims.map((c) => claimKey(c.user_id, c.kind, c.period_key))),
  };
}

/** Drops "skip today" rows and log rows that no window can read any more. Never fails the run. */
async function prune(env: Env, now: Date): Promise<void> {
  const todayUtc = now.toISOString().slice(0, 10);
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reminder_skips WHERE day < ?').bind(addDays(todayUtc, -SKIPS_KEPT_DAYS)),
      env.DB.prepare('DELETE FROM notification_log WHERE sent_at < ?').bind(now.getTime() - LOG_KEPT_DAYS * DAY_MS),
    ]);
  } catch (err) {
    console.error('Scheduled notifications: pruning failed', err);
  }
}

/** Everything due in this run and not claimed yet, user by user. No queries. */
function dueWork(state: RunState, now: Date): Due[] {
  // Everyone in a zone shares the local time of this run, and Intl formatters are not free.
  const zoneTimes = new Map<string, { zone: string; local: LocalTime }>();
  const zoneTime = (tz: string): { zone: string; local: LocalTime } => {
    let t = zoneTimes.get(tz);
    if (!t) {
      const zone = safeTimeZone(tz);
      zoneTimes.set(tz, (t = { zone, local: zonedParts(now, zone) }));
    }
    return t;
  };

  const work: Due[] = [];
  for (const { settings, subs } of state.subscribers) {
    const zones = new Map<string, { local: LocalTime; subs: SubscriptionRow[] }>();
    for (const sub of subs) {
      const { zone, local } = zoneTime(sub.tz);
      const group = zones.get(zone);
      if (group) group.subs.push(sub);
      else zones.set(zone, { local, subs: [sub] });
    }

    for (const [zone, { local, subs: group }] of zones) {
      const add = (kind: ScheduledKind, period: string, day: string) => {
        const periodKey = `${period}@${zone}`;
        if (!state.claimed.has(claimKey(settings.user_id, kind, periodKey))) work.push({ settings, kind, periodKey, day, subs: group });
      };
      if (settings.notif_reminder === 1) {
        const day = dueDay(local, settings.notif_reminder_time, DUE_WINDOW_MINUTES);
        if (day) add('reminder', day, day);
      }
      if (settings.notif_weekly === 1) {
        const day = dueDay(local, WEEKLY_HOUR, DUE_WINDOW_MINUTES);
        if (day && weekdayOf(day) === 1) add('weekly', isoWeekKey(addDays(day, -7)), day);
      }
      if (settings.notif_monthly === 1) {
        const day = dueDay(local, MONTHLY_HOUR, DUE_WINDOW_MINUTES);
        if (day?.endsWith('-01')) add('monthly', addMonths(day, -1).slice(0, 7), day);
      }
    }
  }
  return work;
}

/**
 * Claims the item's period in its zone, then sends. When nobody accepted the message but a device
 * still could, the claim goes back so a later run in the window tries again.
 */
async function deliverOnce(run: Run, item: Due, payloadFor: (lang: ResolvedLanguage) => PushPayload): Promise<void> {
  const userId = item.settings.user_id;
  if (!(await claimNotification(run.env, userId, item.kind, item.periodKey, run.now.getTime()))) return;
  const delivery = await sendToSubscriptions(run.env, item.subs, payloadFor, run.vapid, run.cache);
  if (worthRetrying(delivery)) await releaseNotification(run.env, userId, item.kind, item.periodKey);
}

async function sendReminder(run: Run, item: Due): Promise<void> {
  const { settings, day } = item;
  const state = await run.env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM reminder_skips WHERE user_id = ?1 AND day = ?2) AS skipped,
            EXISTS (SELECT 1 FROM entries WHERE user_id = ?1 AND occurred_at >= ?3 AND occurred_at <= ?4) AS logged`,
  )
    .bind(settings.user_id, day, ...occurredBounds({ from: day, to: day }))
    .first<{ skipped: number; logged: number }>();
  if (state?.skipped) return;
  if (settings.notif_reminder_only_if_empty === 1 && state?.logged) return;
  await deliverOnce(run, item, (lang): PushPayload => {
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
  });
}

async function sendWeekly(run: Run, item: Due): Promise<void> {
  const { settings, day } = item;
  // The window opens on a Monday: last week is the Monday–Sunday that ended yesterday.
  const stats = await periodStats(run.env, settings.user_id, { from: addDays(day, -7), to: addDays(day, -1) });
  if (stats.count === 0) return;
  const previousTotalCents = await periodTotal(run.env, settings.user_id, { from: addDays(day, -14), to: addDays(day, -8) });
  await deliverOnce(run, item, (lang): PushPayload => ({
    kind: 'weekly',
    ...weeklyText(lang, { totalCents: stats.totalCents, currency: settings.currency, count: stats.count, top: stats.top, previousTotalCents }),
    url: '/overview?p=week',
    tag: 'weekly',
    lang,
  }));
}

async function sendMonthly(run: Run, item: Due): Promise<void> {
  const { settings, day } = item;
  const lastMonth = monthRange(addMonths(day, -1));
  const stats = await periodStats(run.env, settings.user_id, lastMonth);
  if (stats.count === 0) return;
  const month = Number(lastMonth.from.slice(5, 7));
  await deliverOnce(run, item, (lang): PushPayload => ({
    kind: 'monthly',
    ...monthlyText(lang, {
      month,
      totalCents: stats.totalCents,
      currency: settings.currency,
      count: stats.count,
      top: stats.top,
      budgetCents: settings.budget_cents,
    }),
    url: `/report?m=${lastMonth.from.slice(0, 7)}`,
    tag: 'monthly',
    lang,
  }));
}

/**
 * Totals for an inclusive day range, and the category that led it. The join carries the owner,
 * as ENTRY_SELECT does, so a category name can only come from the user's own list.
 */
async function periodStats(env: Env, userId: string, range: DayRange): Promise<PeriodStats> {
  const { results } = await env.DB.prepare(
    `SELECT c.name AS name, SUM(e.amount_cents) AS total_cents, COUNT(*) AS count
       FROM entries e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
      WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?
      GROUP BY e.category_id
      ORDER BY total_cents DESC, count DESC, name`,
  )
    .bind(userId, ...occurredBounds(range))
    .all<{ name: string | null; total_cents: number; count: number }>();
  const first = results[0];
  return {
    totalCents: results.reduce((n, r) => n + r.total_cents, 0),
    count: results.reduce((n, r) => n + r.count, 0),
    top: { name: first?.name ?? null, totalCents: first?.total_cents ?? 0 },
  };
}

async function periodTotal(env: Env, userId: string, range: DayRange): Promise<number> {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM entries WHERE user_id = ? AND occurred_at >= ? AND occurred_at <= ?')
    .bind(userId, ...occurredBounds(range))
    .first<{ total: number }>();
  return row?.total ?? 0;
}
