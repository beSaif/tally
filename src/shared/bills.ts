/**
 * Recurring bills: when they come due, and spotting them in past entries. Pure, shared by the
 * Worker and the app. Days are local calendar days 'YYYY-MM-DD'.
 *
 * Every occurrence is counted from the bill's anchor (its first due day), never from the previous
 * one, so a bill on the 31st falls on 28 Feb and is back on the 31st in March.
 */
import type { Cadence } from './api';
import { addDays, addMonths, daysBetween, parseDay } from './dates';

export const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

const MONTH_STEP: Record<Exclude<Cadence, 'weekly'>, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** Occurrence k (0 = the anchor itself). */
export function occurrence(anchor: string, cadence: Cadence, k: number): string {
  return cadence === 'weekly' ? addDays(anchor, 7 * k) : addMonths(anchor, k * MONTH_STEP[cadence]);
}

/** The first occurrence on or after `day` (the anchor when `day` is before it). */
export function firstOnOrAfter(anchor: string, cadence: Cadence, day: string): string {
  if (day <= anchor) return anchor;
  let k: number;
  if (cadence === 'weekly') {
    k = Math.floor((daysBetween(anchor, day) - 1) / 7);
  } else {
    const a = parseDay(anchor);
    const b = parseDay(day);
    k = Math.floor((b.y * 12 + b.m - (a.y * 12 + a.m)) / MONTH_STEP[cadence]);
  }
  // The estimate is at most one step short (a clamped month end, a partial week): walk forward.
  let at = occurrence(anchor, cadence, Math.max(0, k));
  while (at < day) at = occurrence(anchor, cadence, ++k);
  return at;
}

/** The first occurrence strictly after `day`. */
export function nextAfter(anchor: string, cadence: Cadence, day: string): string {
  return firstOnOrAfter(anchor, cadence, addDays(day, 1));
}

export function isOccurrence(anchor: string, cadence: Cadence, day: string): boolean {
  return day >= anchor && firstOnOrAfter(anchor, cadence, day) === day;
}

/** Every occurrence in `from..to` (inclusive), oldest first, at most `limit`. */
export function occurrencesBetween(anchor: string, cadence: Cadence, from: string, to: string, limit = 400): string[] {
  const out: string[] = [];
  let at = firstOnOrAfter(anchor, cadence, from);
  while (at <= to && out.length < limit) {
    out.push(at);
    at = nextAfter(anchor, cadence, at);
  }
  return out;
}

/** What a bill costs per month on average, in cents (a yearly 335.00 → 27.92). */
export function monthlyCents(amountCents: number, cadence: Cadence): number {
  if (cadence === 'weekly') return Math.round((amountCents * 52) / 12);
  return Math.round(amountCents / MONTH_STEP[cadence]);
}

// ---------------------------------------------------------------- spotting bills in entries

export interface PastEntry {
  description: string;
  amount_cents: number;
  currency: string;
  category_id: string | null;
  /** 'YYYY-MM-DDTHH:MM' */
  occurred_at: string;
}

export interface Pattern {
  /** Stable id for "Not a bill": the folded description and the amount. */
  key: string;
  /** The latest entry's wording. */
  description: string;
  amount_cents: number;
  currency: string;
  category_id: string | null;
  cadence: Cadence;
  /** The days it was seen, oldest first (the last few). */
  seen: string[];
  next_due: string;
}

/** Case-, accent- and space-insensitive form of a description. */
export function foldDescription(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const patternKey = (description: string, amountCents: number): string => `${foldDescription(description)}|${amountCents}`;

interface Rule {
  cadence: Cadence;
  /** Allowed gap between two consecutive payments, in days. */
  gap: readonly [number, number];
  /** Payments needed before it counts as a habit. */
  min: number;
  /** The last payment must be at most this many days ago, or the habit has stopped. */
  fresh: number;
}

const RULES: readonly Rule[] = [
  { cadence: 'weekly', gap: [6, 8], min: 4, fresh: 10 },
  { cadence: 'monthly', gap: [26, 35], min: 3, fresh: 45 },
  { cadence: 'quarterly', gap: [84, 98], min: 3, fresh: 120 },
];

/** Payments looked at per pattern: enough to see a beat, recent enough to be today's beat. */
const WINDOW = 6;

/**
 * The same thing at the same price on a steady beat: weekly, monthly or every three months.
 * `known` holds folded descriptions that already are bills and `dismissed` the keys the person
 * said are not bills; both are left out. Newest habit first.
 */
export function findPatterns(entries: readonly PastEntry[], today: string, known: ReadonlySet<string>, dismissed: ReadonlySet<string>): Pattern[] {
  const groups = new Map<string, PastEntry[]>();
  for (const e of entries) {
    const key = patternKey(e.description, e.amount_cents);
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }

  const found: Pattern[] = [];
  for (const [key, group] of groups) {
    if (dismissed.has(key) || known.has(foldDescription(group[0]?.description ?? ''))) continue;
    const sorted = [...group].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
    const days = [...new Set(sorted.map((e) => e.occurred_at.slice(0, 10)))].slice(-WINDOW);
    const last = days[days.length - 1];
    const latest = sorted[sorted.length - 1];
    if (!last || !latest || last > today) continue;
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i] as string, d) - 1);
    const rule = RULES.find((r) => days.length >= r.min && gaps.every((g) => g >= r.gap[0] && g <= r.gap[1]) && daysBetween(last, today) - 1 <= r.fresh);
    if (!rule) continue;
    found.push({
      key,
      description: latest.description,
      amount_cents: latest.amount_cents,
      currency: latest.currency,
      category_id: latest.category_id,
      cadence: rule.cadence,
      seen: days.slice(-3),
      next_due: nextAfter(last, rule.cadence, last),
    });
  }
  return found.sort((a, b) => (a.seen[a.seen.length - 1]! < b.seen[b.seen.length - 1]! ? 1 : -1));
}
