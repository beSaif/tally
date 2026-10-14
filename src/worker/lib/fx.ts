/**
 * Entries paid in another currency count in totals at the reference rate of their day
 * (entries.home_cents, spec §5). Rates come from Frankfurter (ECB and other central banks, no key)
 * and are kept in fx_rates, so each day is fetched once for every account.
 */
import type { DayRange } from '@shared/dates';
import type { Env } from '../env';
import { occurredBounds } from './range';

export const FX_URL = 'https://api.frankfurter.dev/v2/rates';
/** Rate days fetched per request at most; a Free-plan invocation may make 50 outbound fetches. */
export const MAX_FX_FETCHES = 8;
const FX_TIMEOUT_MS = 5_000;

/** Something paid on `day` ('YYYY-MM-DD') in `currency`. */
export interface Paid {
  currency: string;
  day: string;
}

/**
 * entries.home_cents for the row being updated: the amount itself in the person's currency, else
 * converted through the euro rates of its day. NULL (no rate for that day or currency) leaves the
 * row to be filled in later.
 */
const HOME = '(SELECT s.currency FROM settings s WHERE s.user_id = entries.user_id)';
const RATE = (currency: string) => `(SELECT r.per_eur FROM fx_rates r WHERE r.day = substr(entries.occurred_at, 1, 10) AND r.currency = ${currency})`;
const HOME_CENTS = `CASE WHEN entries.currency = ${HOME} THEN entries.amount_cents
  ELSE CAST(ROUND(entries.amount_cents * ${RATE(HOME)} / ${RATE('entries.currency')}) AS INTEGER) END`;

/** Recomputes home_cents for the user's entries matching `where` (a condition on `entries`). */
export function settleHomeCents(db: D1Database, userId: string, where: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(`UPDATE entries SET home_cents = ${HOME_CENTS} WHERE user_id = ? AND (${where})`).bind(userId, ...values);
}

/** The days among `paid` that need rates: those not in `home`. */
export function foreignDays(home: string, paid: readonly Paid[]): string[] {
  return [...new Set(paid.filter((p) => p.currency !== home).map((p) => p.day))];
}

/**
 * Makes sure fx_rates holds every day in `days`, fetching at most MAX_FX_FETCHES missing ones.
 * Never throws: a day that could not be fetched simply stays missing.
 */
export async function ensureRates(env: Env, days: readonly string[]): Promise<void> {
  const wanted = [...new Set(days)];
  if (wanted.length === 0) return;
  const { results } = await env.DB.prepare(`SELECT DISTINCT day FROM fx_rates WHERE day IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(wanted))
    .all<{ day: string }>();
  const have = new Set(results.map((r) => r.day));
  const missing = wanted.filter((d) => !have.has(d)).slice(0, MAX_FX_FETCHES);
  if (missing.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const fetched = await Promise.all(missing.map((day) => fetchRates(env, day > today ? today : day)));
  const inserts = missing.flatMap((day, i) => {
    const rates = fetched[i];
    return rates
      ? [
          env.DB.prepare('INSERT OR REPLACE INTO fx_rates (day, currency, per_eur) SELECT ?, key, value FROM json_each(?)').bind(
            day,
            JSON.stringify({ ...rates, EUR: 1 }),
          ),
        ]
      : [];
  });
  if (inserts.length > 0) await env.DB.batch(inserts);
}

/**
 * Fills in home_cents of the user's entries in `range` that still lack it: their day had no rates
 * when they were written (the service was unreachable), or got them since through another request.
 * Rows in a currency the day's rates do not know are left alone. One query when there is nothing
 * to do (the usual case).
 */
export async function fillHomeCents(env: Env, userId: string, range: DayRange): Promise<void> {
  const bounds = occurredBounds(range);
  const pending = 'home_cents IS NULL AND occurred_at >= ? AND occurred_at <= ?';
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 10) AS day FROM entries
      WHERE user_id = ? AND ${pending}
        AND (NOT EXISTS (SELECT 1 FROM fx_rates r WHERE r.day = substr(entries.occurred_at, 1, 10))
          OR EXISTS (SELECT 1 FROM fx_rates r WHERE r.day = substr(entries.occurred_at, 1, 10) AND r.currency = entries.currency))
      ORDER BY day DESC LIMIT ?`,
  )
    .bind(userId, ...bounds, MAX_FX_FETCHES)
    .all<{ day: string }>();
  if (results.length === 0) return;
  await ensureRates(
    env,
    results.map((r) => r.day),
  );
  await settleHomeCents(env.DB, userId, pending, ...bounds).run();
}

/**
 * After the person's currency changed: every entry counts in the new one. Days whose rates could
 * not be had yet are filled in when their period is next read (fillHomeCents).
 */
export async function rebaseHomeCents(env: Env, userId: string): Promise<void> {
  await ensureRates(env, await daysWithoutRates(env, userId, `currency != ${HOME}`));
  await settleHomeCents(env.DB, userId, '1 = 1').run();
}

/** The latest days of the user's entries matching `where` that fx_rates has nothing for. */
async function daysWithoutRates(env: Env, userId: string, where: string, ...values: unknown[]): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 10) AS day FROM entries
      WHERE user_id = ? AND (${where}) AND NOT EXISTS (SELECT 1 FROM fx_rates r WHERE r.day = substr(entries.occurred_at, 1, 10))
      ORDER BY day DESC LIMIT ?`,
  )
    .bind(userId, ...values, MAX_FX_FETCHES)
    .all<{ day: string }>();
  return results.map((r) => r.day);
}

/** Units per euro of every currency Frankfurter knows on `day` (the last rates published by then). */
async function fetchRates(env: Env, day: string): Promise<Record<string, number> | null> {
  const url = `${env.FX_URL ?? FX_URL}?date=${day}&base=EUR`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FX_TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const rates: Record<string, number> = {};
    if (Array.isArray(body)) {
      for (const r of body as Array<{ quote?: unknown; rate?: unknown }>) {
        if (typeof r.quote === 'string' && /^[A-Z]{3}$/.test(r.quote) && typeof r.rate === 'number' && r.rate > 0) rates[r.quote] = r.rate;
      }
    }
    if (Object.keys(rates).length === 0) throw new Error('no rates');
    return rates;
  } catch (err) {
    console.error(`Exchange rates for ${day} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
