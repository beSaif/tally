import type { Context } from 'hono';
import { daysBetween, type DayRange } from '@shared/dates';
import { rangeQuerySchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { readQuery, validation } from './http';

/** Longest inclusive day range a list, summary or export accepts: a leap year. */
export const MAX_RANGE_DAYS = 366;

/** 400 unless `from..to` is ordered and spans at most MAX_RANGE_DAYS days (inclusive). */
export function assertRange(range: DayRange, names: readonly [string, string] = ['from', 'to']): void {
  const [fromName, toName] = names;
  if (range.from > range.to) throw validation(`${toName}: must not be before ${fromName}`);
  if (daysBetween(range.from, range.to) > MAX_RANGE_DAYS) {
    throw validation(`${toName}: a range spans at most ${MAX_RANGE_DAYS} days`);
  }
}

/** Reads and checks `?from=YYYY-MM-DD&to=YYYY-MM-DD`. */
export function readRange(c: Context<AppEnv>): DayRange {
  const { from, to } = readQuery(c, rangeQuerySchema);
  const range = { from, to };
  assertRange(range);
  return range;
}

/**
 * occurred_at bounds of an inclusive day range. occurred_at is fixed-width local text, so a plain
 * string comparison is chronological and keeps the entries(user_id, occurred_at) index usable.
 */
export function occurredBounds(range: DayRange): [string, string] {
  return [`${range.from}T00:00`, `${range.to}T23:59`];
}
