/**
 * Typed client for the Worker API (spec §6). JSON in/out, cookie session (same origin).
 * Errors become `ApiError` with the server's code; a network failure is the `offline` code.
 * A 401 `unauthorized` means the session is gone: the registered handler logs the app out.
 * Signing in is not a call: the browser leaves for `/api/auth/google/start` and comes back signed in.
 */
import type {
  Bootstrap,
  CategoriesInput,
  Category,
  DeleteAccountInput,
  Entry,
  EntryPatch,
  MonthsSummary,
  ErrorCode,
  NewEntry,
  PushSubscriptionInput,
  PushSubscriptionRow,
  ResolvedLanguage,
  Settings,
  SettingsInput,
  Summary,
} from '@shared/api';

export type ApiErrorCode = ErrorCode | 'offline' | 'http';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  constructor(code: ApiErrorCode, status: number, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export const isAbortError = (e: unknown): boolean =>
  (e instanceof DOMException || e instanceof Error) && (e.name === 'AbortError' || e.name === 'TimeoutError');

interface Handlers {
  unauthorized?: () => void;
  offline?: () => void;
}
const handlers: Handlers = {};

/** The app registers what a lost session / a network failure does (log out, toast). */
export function setApiHandlers(h: Handlers): void {
  Object.assign(handlers, h);
}

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>(['unauthorized', 'validation', 'not_found', 'rate_limited', 'forbidden', 'internal']);

function codeFor(status: number, body: unknown): ApiErrorCode {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === 'string' && KNOWN_CODES.has(code)) return code as ErrorCode;
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'http';
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Don't run the logged-out handler on 401 (bootstrap probes the session itself). */
  quiet401?: boolean;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    handlers.offline?.();
    throw new ApiError('offline', 0, 'Network request failed');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const code = codeFor(res.status, data);
    const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
    if (code === 'unauthorized' && !opts.quiet401) handlers.unauthorized?.();
    throw new ApiError(code, res.status, typeof message === 'string' ? message : `HTTP ${res.status}`);
  }
  return data as T;
}

const q = (params: Record<string, string | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
};

export interface SummaryQuery {
  from: string;
  to: string;
  prev_from?: string;
  prev_to?: string;
}

export const api = {
  // ---- auth ----
  /** A full-page navigation (not a fetch): the Worker sends the browser on to Google and back. */
  googleSignInUrl: (lang: ResolvedLanguage) => `/api/auth/google/start${q({ lang })}`,
  me: (opts?: RequestOptions) => request<Bootstrap>('GET', '/auth/me', undefined, opts),
  logout: () => request<void>('POST', '/auth/logout', undefined, { quiet401: true }),
  deleteAccount: (body: DeleteAccountInput) => request<void>('DELETE', '/auth/account', body),

  // ---- settings & categories ----
  getSettings: () => request<{ settings: Settings }>('GET', '/settings'),
  putSettings: (body: SettingsInput) => request<{ settings: Settings }>('PUT', '/settings', body),
  getCategories: () => request<{ categories: Category[] }>('GET', '/categories'),
  putCategories: (body: CategoriesInput) => request<{ categories: Category[] }>('PUT', '/categories', body),

  // ---- entries ----
  listEntries: (from: string, to: string, opts?: RequestOptions) => request<{ entries: Entry[] }>('GET', `/entries${q({ from, to })}`, undefined, opts),
  createEntries: (entries: NewEntry[]) => request<{ entries: Entry[] }>('POST', '/entries', { entries }),
  patchEntry: (id: string, patch: EntryPatch) => request<{ entry: Entry }>('PATCH', `/entries/${encodeURIComponent(id)}`, patch),
  deleteEntry: (id: string) => request<void>('DELETE', `/entries/${encodeURIComponent(id)}`),

  // ---- reports ----
  summary: (query: SummaryQuery, opts?: RequestOptions) => request<Summary>('GET', `/summary${q({ ...query })}`, undefined, opts),
  summaryMonths: (from: string, to: string, opts?: RequestOptions) => request<MonthsSummary>('GET', `/summary/months${q({ from, to })}`, undefined, opts),
  exportUrl: (from: string, to: string) => `/api/export.csv${q({ from, to })}`,

  // ---- push ----
  vapidKey: () => request<{ key: string }>('GET', '/push/vapid-public-key'),
  pushSubscriptions: () => request<{ subscriptions: PushSubscriptionRow[] }>('GET', '/push/subscriptions'),
  pushSubscribe: (body: PushSubscriptionInput) => request<{ id: string }>('POST', '/push/subscribe', body),
  pushPatch: (id: string, body: { lang?: ResolvedLanguage; tz?: string }) => request<void>('PATCH', `/push/subscriptions/${encodeURIComponent(id)}`, body),
  pushDelete: (id: string) => request<void>('DELETE', `/push/subscriptions/${encodeURIComponent(id)}`),
  pushTest: (endpoint?: string) => request<{ sent: number }>('POST', '/push/test', endpoint ? { endpoint } : {}),
};
