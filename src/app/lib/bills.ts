/**
 * Recurring bills on this device: the list (synced when Home or the calendar opens, which also logs
 * the automatic bills that came due), habits that look like bills, and what is due now.
 */
import { computed, effect, signal } from '@preact/signals';
import type { Bill, BillPatch, BillSuggestion, Entry, NewBill } from '@shared/api';
import { foldDescription } from '@shared/bills';
import { lang, t } from '../i18n';
import { api, isApiError } from './api';
import { todayLocal, weekdayDayMonth } from './format';
import { addEntries, removeEntry } from './ledger';
import { user } from './store';
import { showToast } from './toast';

const SNOOZE_KEY = 'tally.bills.snoozed';

export const bills = signal<Bill[]>([]);
export const billsLoaded = signal(false);
export const suggestions = signal<BillSuggestion[]>([]);
/** "Not yet": bill id → the local day it was put off. The card is back the next day. */
export const snoozed = signal<Readonly<Record<string, string>>>(readSnoozed());

function readSnoozed(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SNOOZE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Bumped when the account changes so a late response for the previous one is dropped. */
let generation = 0;
let lastUserId: string | null | undefined;
effect(() => {
  const id = user.value?.id ?? null;
  if (id === lastUserId) return;
  lastUserId = id;
  generation++;
  bills.value = [];
  suggestions.value = [];
  billsLoaded.value = false;
});

const byDue = (list: readonly Bill[]): Bill[] =>
  [...list].sort((a, b) => (a.next_due === b.next_due ? a.description.localeCompare(b.description) : a.next_due < b.next_due ? -1 : 1));

function putBill(bill: Bill): void {
  bills.value = byDue([...bills.value.filter((b) => b.id !== bill.id), bill]);
}

/** Every bill, after the server logged the automatic ones that came due by today. */
export async function syncBills(): Promise<void> {
  const gen = generation;
  try {
    const res = await api.syncBills(todayLocal());
    if (gen !== generation) return;
    bills.value = byDue(res.bills);
    billsLoaded.value = true;
    if (res.logged.length > 0) addEntries(res.logged, { fresh: false });
  } catch {
    /* offline or a hiccup: keep what is shown, the next sync catches up */
  }
}

export async function loadSuggestions(): Promise<void> {
  const gen = generation;
  try {
    const res = await api.billSuggestions(todayLocal());
    if (gen === generation) suggestions.value = res.suggestions;
  } catch {
    /* suggestions are a nicety */
  }
}

function dropSuggestionsFor(description: string): void {
  const folded = foldDescription(description);
  suggestions.value = suggestions.value.filter((s) => foldDescription(s.description) !== folded);
}

/** "Not a bill": stop suggesting it, here and on the server. */
export async function dismissSuggestion(s: BillSuggestion): Promise<void> {
  suggestions.value = suggestions.value.filter((x) => x.key !== s.key);
  try {
    await api.dismissSuggestion(s.key);
  } catch {
    /* it may come back next time; nothing is lost */
  }
}

export async function createBill(input: NewBill): Promise<{ bill: Bill; entry: Entry | null }> {
  const res = await api.createBill(input);
  putBill(res.bill);
  dropSuggestionsFor(res.bill.description);
  if (res.entry) addEntries([res.entry], { fresh: true });
  return res;
}

export async function updateBill(id: string, patch: BillPatch): Promise<Bill> {
  const { bill } = await api.patchBill(id, patch);
  putBill(bill);
  return bill;
}

export async function deleteBill(id: string): Promise<void> {
  await api.deleteBill(id);
  bills.value = bills.value.filter((b) => b.id !== id);
}

/** A 409: another device or tap already moved the bill on. Show what the server has. */
async function afterConflict(err: unknown): Promise<never> {
  if (isApiError(err) && err.status === 409) await syncBills();
  throw err;
}

/** "Paid it": logs the due occurrence, moves the bill on, and offers to undo. */
export async function payBill(bill: Bill, occurredAt: string): Promise<{ bill: Bill; entry: Entry }> {
  const due = bill.next_due;
  const res = await api.payBill(bill.id, { due, occurred_at: occurredAt }).catch(afterConflict);
  putBill(res.bill);
  addEntries([res.entry], { fresh: true });
  showToast({
    text: t('bills.logged', { date: nextLabel(res.bill.next_due) }),
    actionLabel: t('entry.undo'),
    onAction: () => void undoPay(res.bill.id, due, res.entry.id),
    duration: 6000,
  });
  return res;
}

async function undoPay(billId: string, due: string, entryId: string): Promise<void> {
  try {
    await api.deleteEntry(entryId);
    removeEntry(entryId);
    putBill((await api.patchBill(billId, { next_due: due })).bill);
  } catch {
    showToast({ text: t('toast.error') });
  }
}

/** "Skip this one": the due occurrence passes without an entry. */
export async function skipBill(bill: Bill): Promise<Bill> {
  const { bill: next } = await api.skipBill(bill.id, { due: bill.next_due }).catch(afterConflict);
  putBill(next);
  return next;
}

/** "Not yet": hide the due card until tomorrow. */
export function snooze(bill: Bill): void {
  const today = todayLocal();
  // Old days are of no use any more: keep only today's.
  const next: Record<string, string> = { [bill.id]: today };
  for (const [id, day] of Object.entries(snoozed.value)) if (day === today) next[id] = day;
  snoozed.value = next;
  try {
    window.localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
  } catch {
    /* blocked storage: it still holds for this session */
  }
}

/** Bills that wait for "Paid it" and whose day has come (overdue first), unless put off today. */
export const dueNow = computed<Bill[]>(() => {
  const today = todayLocal();
  return bills.value.filter((b) => b.mode === 'ask' && b.next_due <= today && snoozed.value[b.id] !== today);
});

/** "Thu 15 Oct" for a due day. */
export function nextLabel(day: string): string {
  return weekdayDayMonth(day, lang.value);
}
