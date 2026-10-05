/**
 * The home list: the current month, plus earlier months loaded on demand ("SHOW SEPTEMBER →").
 * Entries created in this session are flagged `fresh` for the 1.5s highlight.
 */
import { computed, effect, signal } from '@preact/signals';
import type { Entry } from '@shared/api';
import { addMonths, monthRange, toLocalDay } from '@shared/dates';
import { api } from './api';
import { dayOf, monthKeyOf, sortEntries, todayLocal } from './format';
import { user } from './store';

export interface MonthBlock {
  key: string; // 'YYYY-MM'
  from: string;
  to: string;
  entries: Entry[];
  status: 'loading' | 'ready' | 'error';
}

export const months = signal<MonthBlock[]>([]);
export const freshIds = signal<ReadonlySet<string>>(new Set());

/** Bumped on reset so a response for a previous account or month is dropped. */
let generation = 0;

function reset(): void {
  generation++;
  months.value = [];
  freshIds.value = new Set();
}

let lastUserId: string | null | undefined;
effect(() => {
  const id = user.value?.id ?? null;
  if (id !== lastUserId) {
    lastUserId = id;
    reset();
  }
});

function patchBlock(key: string, fn: (b: MonthBlock) => MonthBlock): void {
  months.value = months.value.map((b) => (b.key === key ? fn(b) : b));
}

async function fill(key: string, from: string, to: string): Promise<void> {
  const gen = generation;
  try {
    const { entries } = await api.listEntries(from, to);
    if (gen !== generation) return;
    patchBlock(key, (b) => ({ ...b, entries: sortEntries(entries), status: 'ready' }));
  } catch {
    if (gen !== generation) return;
    // Keep what we had on a failed refresh; only a first load shows the error state.
    patchBlock(key, (b) => ({ ...b, status: b.status === 'ready' ? 'ready' : 'error' }));
  }
}

/** Loads (or refreshes) the current month. A new month replaces the list. */
export async function loadCurrentMonth(): Promise<void> {
  const today = todayLocal();
  const { from, to } = monthRange(today);
  const key = monthKeyOf(today);
  if (months.value[0]?.key !== key) {
    generation++;
    months.value = [{ key, from, to, entries: [], status: 'loading' }];
  }
  await fill(key, from, to);
}

/** Appends the month before the last loaded one. */
export async function loadOlderMonth(): Promise<void> {
  const list = months.value;
  const last = list[list.length - 1];
  if (!last || last.status === 'loading') return;
  const { from, to } = monthRange(addMonths(last.from, -1));
  const key = monthKeyOf(from);
  months.value = [...list, { key, from, to, entries: [], status: 'loading' }];
  await fill(key, from, to);
}

/** First day of the month that "SHOW … →" would load next, or null. */
export const nextOlderMonth = computed<string | null>(() => {
  const list = months.value;
  const last = list[list.length - 1];
  if (!last || last.status !== 'ready') return null;
  const candidate = monthRange(addMonths(last.from, -1)).from;
  const created = user.value ? monthRange(toLocalDay(new Date(user.value.created_at))).from : candidate;
  // Before the account existed only backdated entries can exist: keep going while months have data.
  if (candidate >= created || last.entries.length > 0) return candidate;
  return null;
});

function insertInto(list: MonthBlock[], entry: Entry): MonthBlock[] {
  const day = dayOf(entry.occurred_at);
  return list.map((b) => (day >= b.from && day <= b.to ? { ...b, entries: sortEntries([...b.entries, entry]) } : b));
}

const withoutId = (list: MonthBlock[], id: string): MonthBlock[] =>
  list.map((b) => (b.entries.some((e) => e.id === id) ? { ...b, entries: b.entries.filter((e) => e.id !== id) } : b));

let freshTimer: ReturnType<typeof setTimeout> | undefined;

export function addEntries(created: readonly Entry[], opts: { fresh?: boolean } = {}): void {
  let list = months.value;
  for (const e of created) list = insertInto(withoutId(list, e.id), e);
  months.value = list;
  if (opts.fresh ?? true) {
    freshIds.value = new Set([...freshIds.value, ...created.map((e) => e.id)]);
    clearTimeout(freshTimer);
    // Drop the flag after the CSS animation so a later re-render does not replay it.
    freshTimer = setTimeout(() => (freshIds.value = new Set()), 1700);
  }
}

export function replaceEntry(entry: Entry): void {
  months.value = insertInto(withoutId(months.value, entry.id), entry);
}

export function removeEntry(id: string): void {
  months.value = withoutId(months.value, id);
}

export function findEntry(id: string): Entry | undefined {
  for (const b of months.value) {
    const e = b.entries.find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}
