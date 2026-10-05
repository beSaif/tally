/**
 * The home list: the current month, plus earlier months loaded on demand ("SHOW SEPTEMBER →").
 * The loaded months are contiguous, newest first. Entries created in this session are flagged
 * `fresh` for the 1.5s highlight.
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
/**
 * The earliest day of an entry saved here into a month older than every loaded one. "SHOW …" keeps
 * going down to that month even where the account's age and empty months would stop it.
 */
const savedBefore = signal<string | null>(null);

/** Bumped on reset so a response for a previous account or month is dropped. */
let generation = 0;

function reset(): void {
  generation++;
  months.value = [];
  freshIds.value = new Set();
  savedBefore.value = null;
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

/**
 * Loads (or refreshes) the current month. When the month has turned since the list was loaded (the
 * app stayed open into it), the new month goes on top and the months already loaded stay; a month
 * that does not directly follow them (a long pause, a changed clock) replaces the list.
 */
export async function loadCurrentMonth(): Promise<void> {
  const today = todayLocal();
  const { from, to } = monthRange(today);
  const key = monthKeyOf(today);
  const list = months.value;
  if (list[0]?.key !== key) {
    const follows = list[0]?.key === monthKeyOf(addMonths(from, -1));
    if (!follows) generation++;
    months.value = [{ key, from, to, entries: [], status: 'loading' }, ...(follows ? list : [])];
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
  const saved = savedBefore.value;
  // Before the account existed only backdated entries can exist: keep going while months have data,
  // and down to the month of an entry saved here that no loaded month holds.
  if (candidate >= created || last.entries.length > 0 || (saved !== null && monthKeyOf(saved) <= monthKeyOf(candidate))) return candidate;
  return null;
});

const withoutId = (list: readonly MonthBlock[], id: string): MonthBlock[] =>
  list.map((b) => (b.entries.some((e) => e.id === id) ? { ...b, entries: b.entries.filter((e) => e.id !== id) } : b));

export interface Placement {
  list: MonthBlock[];
  /** Some entry falls after the newest loaded month (the month has turned, or a future month). */
  newer: boolean;
  /** The earliest day among entries older than every loaded month, else null. */
  oldest: string | null;
}

/**
 * Puts saved entries into the loaded month that holds their day, dropping any earlier copy (an edit
 * can move an entry to another day or month). The loaded months are contiguous, so an entry none of
 * them holds is newer or older than all of them: it is reported, not dropped.
 */
export function placeEntries(list: readonly MonthBlock[], saved: readonly Entry[]): Placement {
  let next = [...list];
  let newer = false;
  let oldest: string | null = null;
  for (const entry of saved) {
    next = withoutId(next, entry.id);
    const day = dayOf(entry.occurred_at);
    const at = next.findIndex((b) => day >= b.from && day <= b.to);
    if (at >= 0) next = next.map((b, i) => (i === at ? { ...b, entries: sortEntries([...b.entries, entry]) } : b));
    else if (!next[0] || day > next[0].to) newer = true;
    else if (oldest === null || day < oldest) oldest = day;
  }
  return { list: next, newer, oldest };
}

/** Shows saved entries where they belong, so the list and its totals match the server. */
function place(saved: readonly Entry[]): void {
  const { list, newer, oldest } = placeEntries(months.value, saved);
  months.value = list;
  // An older month is not loaded yet: make sure "SHOW …" leads there.
  if (oldest !== null && (savedBefore.value === null || oldest < savedBefore.value)) savedBefore.value = oldest;
  // A newer one means the month has turned since the list was loaded: the new month goes on top
  // (loadCurrentMonth adds it before its first await) and shows the entry at once; its load brings
  // the rest from the server. An entry in a future month waits for its month, like the list does.
  if (newer && months.value[0]?.key !== monthKeyOf(todayLocal())) {
    const loading = loadCurrentMonth();
    months.value = placeEntries(months.value, saved).list;
    void loading;
  }
}

let freshTimer: ReturnType<typeof setTimeout> | undefined;

export function addEntries(created: readonly Entry[], opts: { fresh?: boolean } = {}): void {
  place(created);
  if (opts.fresh ?? true) {
    freshIds.value = new Set([...freshIds.value, ...created.map((e) => e.id)]);
    clearTimeout(freshTimer);
    // Drop the flag after the CSS animation so a later re-render does not replay it.
    freshTimer = setTimeout(() => (freshIds.value = new Set()), 1700);
  }
}

export function replaceEntry(entry: Entry): void {
  place([entry]);
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
