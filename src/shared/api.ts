/**
 * API contract shared by the Worker and the app. Keep in sync with docs/SPEC.md §6.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_credentials'
  | 'email_taken'
  | 'invite_required'
  | 'signups_disabled'
  | 'validation'
  | 'not_found'
  | 'rate_limited'
  | 'forbidden'
  | 'internal';

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
}

export interface CategoriesInput {
  categories: Array<{ id?: string; name: string }>;
}

export interface Entry {
  id: string;
  amount_cents: number;
  currency: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  occurred_at: string; // 'YYYY-MM-DDTHH:MM' local
  note: string | null;
  source: EntrySource;
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
}

// ---- auth ----
export interface SignupInput {
  email: string;
  password: string;
  language: ResolvedLanguage;
  invite_code?: string;
}
export interface LoginInput {
  email: string;
  password: string;
}
export interface PasswordChangeInput {
  current: string;
  new: string;
}
export interface DeleteAccountInput {
  password: string;
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
