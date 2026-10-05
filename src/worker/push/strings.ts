/**
 * Notification texts, English and French. Amounts use `formatAmount` in both languages (Swiss
 * convention, as in the app). French typography puts a narrow no-break space (U+202F) before
 * `:`, `?`, `!` and `%` (docs/SPEC.md §4).
 */
import type { ResolvedLanguage } from '@shared/api';
import { formatAmount, formatBudget, NNBSP, percentOf } from '@shared/money';

const MINUS = '−';

export interface NotificationText {
  title: string;
  body: string;
}

export interface ReminderText extends NotificationText {
  /** Action button titles. */
  log: string;
  skip: string;
}

/** The category that led a period; `name` null means uncategorised ("Other"). */
export interface TopCategory {
  name: string | null;
  totalCents: number;
}

export interface BudgetTextInput {
  threshold: number;
  spentCents: number;
  budgetCents: number;
  currency: string;
  /** Days remaining in the month after today. */
  daysLeft: number;
}

export interface WeeklyTextInput {
  totalCents: number;
  currency: string;
  count: number;
  top: TopCategory;
  /** Total of the week before; 0 when nothing was logged then. */
  previousTotalCents: number;
}

export interface MonthlyTextInput {
  /** 1–12, the month being reported. */
  month: number;
  totalCents: number;
  currency: string;
  count: number;
  top: TopCategory;
  budgetCents: number | null;
}

interface Dict {
  other: string;
  reminder: ReminderText;
  test: NotificationText;
  months: readonly string[];
  budgetTitle(threshold: number): string;
  daysLeft(n: number): string;
  budgetBody(spent: string, budget: string, currency: string, daysLeft: string): string;
  entries(n: number): string;
  percent(n: number): string;
  weeklyTitle(amount: string, currency: string): string;
  weeklyLed(name: string, share: number): string;
  weeklyDelta(deltaPct: number): string;
  monthlyTitle(month: string, amount: string, currency: string): string;
  monthlyLed(name: string, amount: string): string;
  ofBudget(pct: number): string;
}

const signed = (n: number, percent: (n: number) => string): string => (n > 0 ? `+${percent(n)}` : `${MINUS}${percent(-n)}`);

const en: Dict = {
  other: 'Other',
  reminder: { title: 'Anything spent today?', body: 'One sentence is enough.', log: 'Log now', skip: 'Skip today' },
  test: { title: 'Notifications are on', body: 'This is how Tally will nudge you.' },
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  budgetTitle: (t) => (t === 50 ? 'Halfway through your budget' : t >= 100 ? 'Budget reached' : `${t}% of your budget`),
  daysLeft: (n) => (n <= 0 ? 'last day of the month' : n === 1 ? '1 day left' : `${n} days left`),
  budgetBody: (spent, budget, currency, daysLeft) => `${spent} of ${budget} ${currency} · ${daysLeft}`,
  entries: (n) => (n === 1 ? '1 entry' : `${n} entries`),
  percent: (n) => `${n}%`,
  weeklyTitle: (amount, currency) => `Last week: ${amount} ${currency}`,
  weeklyLed: (name, share) => `${name} led at ${share}%`,
  weeklyDelta: (d) => (d === 0 ? 'same as the week before' : `${signed(d, en.percent)} vs the week before`),
  monthlyTitle: (month, amount, currency) => `${month}: ${amount} ${currency}`,
  monthlyLed: (name, amount) => `${name} ${amount} led`,
  ofBudget: (pct) => `${pct}% of your budget`,
};

const fr: Dict = {
  other: 'Autre',
  reminder: { title: `Des dépenses aujourd’hui${NNBSP}?`, body: 'Une phrase suffit.', log: 'Noter', skip: 'Pas aujourd’hui' },
  test: { title: 'Notifications activées', body: 'Voici comment Tally vous fera signe.' },
  months: ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'],
  budgetTitle: (t) => (t === 50 ? 'La moitié du budget est atteinte' : t >= 100 ? 'Budget atteint' : `${t}${NNBSP}% du budget`),
  daysLeft: (n) => (n <= 0 ? 'dernier jour du mois' : n === 1 ? '1 jour restant' : `${n} jours restants`),
  budgetBody: (spent, budget, currency, daysLeft) => `${spent} sur ${budget} ${currency} · ${daysLeft}`,
  entries: (n) => (n === 1 ? '1 dépense' : `${n} dépenses`),
  percent: (n) => `${n}${NNBSP}%`,
  weeklyTitle: (amount, currency) => `Semaine passée${NNBSP}: ${amount} ${currency}`,
  weeklyLed: (name, share) => `${name} en tête avec ${share}${NNBSP}%`,
  weeklyDelta: (d) => (d === 0 ? 'comme la semaine d’avant' : `${signed(d, fr.percent)} par rapport à la semaine d’avant`),
  monthlyTitle: (month, amount, currency) => `${month}${NNBSP}: ${amount} ${currency}`,
  monthlyLed: (name, amount) => `${name} en tête avec ${amount}`,
  ofBudget: (pct) => `${pct}${NNBSP}% du budget`,
};

const DICTS: Record<ResolvedLanguage, Dict> = { en, fr };

const dict = (lang: ResolvedLanguage): Dict => DICTS[lang] ?? en;
const categoryName = (d: Dict, top: TopCategory): string => top.name ?? d.other;

export function reminderText(lang: ResolvedLanguage): ReminderText {
  return { ...dict(lang).reminder };
}

export function testText(lang: ResolvedLanguage): NotificationText {
  return { ...dict(lang).test };
}

/** "Halfway through your budget" · "1 620.00 of 2 000 CHF · 17 days left". */
export function budgetText(lang: ResolvedLanguage, input: BudgetTextInput): NotificationText {
  const d = dict(lang);
  return {
    title: d.budgetTitle(input.threshold),
    body: d.budgetBody(formatAmount(input.spentCents), formatBudget(input.budgetCents), input.currency, d.daysLeft(input.daysLeft)),
  };
}

/** "Last week: 256.90 CHF" · "Groceries led at 41% · 12 entries" (or the change against the week before). */
export function weeklyText(lang: ResolvedLanguage, input: WeeklyTextInput): NotificationText {
  const d = dict(lang);
  const led = d.weeklyLed(categoryName(d, input.top), percentOf(input.top.totalCents, input.totalCents));
  const tail = input.previousTotalCents > 0 ? d.weeklyDelta(percentOf(input.totalCents - input.previousTotalCents, input.previousTotalCents)) : d.entries(input.count);
  return { title: d.weeklyTitle(formatAmount(input.totalCents), input.currency), body: `${led} · ${tail}` };
}

/** "September: 1 284.60 CHF" · "64% of your budget · Groceries 412.30 led" (no budget: "… led · 38 entries"). */
export function monthlyText(lang: ResolvedLanguage, input: MonthlyTextInput): NotificationText {
  const d = dict(lang);
  const led = d.monthlyLed(categoryName(d, input.top), formatAmount(input.top.totalCents));
  const body = input.budgetCents && input.budgetCents > 0 ? `${d.ofBudget(percentOf(input.totalCents, input.budgetCents))} · ${led}` : `${led} · ${d.entries(input.count)}`;
  return { title: d.monthlyTitle(d.months[input.month - 1] ?? '', formatAmount(input.totalCents), input.currency), body };
}
