/**
 * API contract shared by the Worker and the app. Keep in sync with docs/SPEC.md §6.
 */

export type ErrorCode = 'unauthorized' | 'validation' | 'not_found' | 'rate_limited' | 'forbidden' | 'internal';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

export type Language = 'auto' | 'en' | 'fr';
export type ResolvedLanguage = 'en' | 'fr';
export type EntrySource = 'text' | 'voice' | 'photo' | 'manual';

export interface User {
  id: string;
  email: string;
  created_at: number;
}

export interface NotificationPrefs {
  reminder: boolean;
  reminder_time: string; // 'HH:MM'
  reminder_only_if_empty: boolean;
  budget: boolean;
  weekly: boolean;
  monthly: boolean;
}

export interface Settings {
  currency: string;
  language: Language;
  budget_cents: number | null;
  model: string;
  setup_complete: boolean;
  notifications: NotificationPrefs;
  updated_at: number;
}

export type SettingsInput = Partial<{
  currency: string;
  language: Language;
  budget_cents: number | null;
  model: string;
  setup_complete: boolean;
  notifications: Partial<NotificationPrefs>;
}>;

export interface Category {
  id: string;
  name: string;
  position: number;
  /** Monthly budget for this category; null when none is set. */
  budget_cents: number | null;
  /** A fixed cost (rent, bills) rather than day-to-day spending. */
  fixed: boolean;
}

/** `PATCH /api/categories/:id`: a category's budget and fixed-cost flag (names go through PUT). */
export interface CategoryPatch {
  budget_cents?: number | null;
  fixed?: boolean;
}

export interface CategoriesInput {
  categories: Array<{ id?: string; name: string }>;
}

export interface Entry {
  id: string;
  amount_cents: number;
  currency: string;
  /**
   * What it counts for in the person's currency (settings), converted at its day's reference rate
   * when `currency` is another one. Null while no rate is known: totals then count amount_cents.
   */
  home_cents: number | null;
  description: string;
  category_id: string | null;
  category_name: string | null;
  occurred_at: string; // 'YYYY-MM-DDTHH:MM' local
  note: string | null;
  source: EntrySource;
  /** The recurring bill this entry paid, if any. */
  bill_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewEntry {
  amount_cents: number;
  currency?: string;
  description: string;
  /** Explicit category id; takes precedence over `category`. */
  category_id?: string | null;
  /** Category name (case-insensitive); unknown names resolve to null. */
  category?: string | null;
  occurred_at: string;
  note?: string | null;
  source: EntrySource;
  raw_input?: string | null;
}

export type EntryPatch = Partial<NewEntry>;

// ---- recurring bills ----
export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
/** auto: logged by itself on the due day; ask: waits for "Paid it". */
export type BillMode = 'auto' | 'ask';

export interface Bill {
  id: string;
  amount_cents: number;
  currency: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  cadence: Cadence;
  /** The first due day; every occurrence counts from it. 'YYYY-MM-DD' */
  anchor: string;
  /** The first occurrence not paid or skipped yet. 'YYYY-MM-DD' */
  next_due: string;
  mode: BillMode;
  created_at: number;
  updated_at: number;
}

/** `POST /api/bills`. */
export interface NewBill {
  amount_cents: number;
  currency?: string;
  description: string;
  category_id?: string | null;
  cadence: Cadence;
  /** 'YYYY-MM-DD' */
  first_due: string;
  mode: BillMode;
  /** The first occurrence is already paid: log it as an entry at this minute and move on to the next. */
  paid_at?: string | null;
  source?: EntrySource;
  raw_input?: string | null;
}

/** `PATCH /api/bills/:id`. A next_due off the bill's beat (or a new cadence) restarts the beat there. */
export type BillPatch = Partial<{
  amount_cents: number;
  description: string;
  category_id: string | null;
  cadence: Cadence;
  next_due: string;
  mode: BillMode;
}>;

/** `POST /api/bills/:id/pay` and `/skip`: `due` is the next_due the person saw, so a second tap does nothing twice. */
export interface BillDueInput {
  due: string;
  /** pay only: when it was paid, 'YYYY-MM-DDTHH:MM'. */
  occurred_at?: string;
}

/** `GET /api/bills/:id`: the bill and the entries that paid it, newest first. */
export interface BillDetail {
  bill: Bill;
  entries: Entry[];
}

/** `POST /api/bills/sync`: every bill, after logging the automatic ones that came due. */
export interface BillsSync {
  bills: Bill[];
  /** Entries logged by this call. */
  logged: Entry[];
}

/** A habit spotted in past entries that looks like a bill (`GET /api/bills/suggestions`). */
export interface BillSuggestion {
  key: string;
  description: string;
  amount_cents: number;
  currency: string;
  category_id: string | null;
  cadence: Cadence;
  seen: string[];
  next_due: string;
}

export interface SummaryCategory {
  category_id: string | null;
  name: string | null;
  total_cents: number;
  count: number;
  prev_total_cents?: number;
}

export interface Summary {
  from: string;
  to: string;
  total_cents: number;
  count: number;
  by_category: SummaryCategory[];
  by_day: Array<{ day: string; total_cents: number; count: number }>;
  previous?: { total_cents: number; count: number };
  /** The day of the user's newest entry in any period ('YYYY-MM-DD'), null with none; can be after today. */
  last_day: string | null;
}

/** One calendar month of `GET /api/summary/months`: its total and per-category totals. */
export interface MonthSummary {
  month: string; // 'YYYY-MM'
  total_cents: number;
  count: number;
  by_category: SummaryCategory[];
}

/** `GET /api/summary/months?from=YYYY-MM&to=YYYY-MM`: every month in the range, oldest first, empty ones included. */
export interface MonthsSummary {
  months: MonthSummary[];
}

// ---- auth ----
/** Why a Google sign-in came back to `/login` without a session (the `error` query parameter). */
export type SignInError = 'cancelled' | 'failed' | 'signups_disabled';
export interface DeleteAccountInput {
  /** The account's email, typed again as confirmation. */
  email: string;
}
export interface Bootstrap {
  user: User;
  settings: Settings;
  categories: Category[];
}

// ---- push ----
export interface PushSubscriptionInput {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  user_agent?: string;
  lang: ResolvedLanguage;
  tz: string;
}
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  user_agent: string | null;
  lang: ResolvedLanguage;
  tz: string;
  created_at: number;
  last_seen_at: number;
}
export type PushKind = 'reminder' | 'budget' | 'weekly' | 'monthly' | 'test';
export interface PushPayload {
  kind: PushKind;
  title: string;
  body: string;
  url: string;
  tag: string;
  lang: ResolvedLanguage;
  /** Reminder only: the local day, so "Skip today" can be recorded. */
  day?: string;
  actions?: Array<{ action: 'log' | 'skip' | 'open'; title: string }>;
}
