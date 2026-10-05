/**
 * What the service worker does with a push and with a click on its notification (spec §8.1–8.2),
 * written against small interfaces so it can be unit-tested without a worker.
 */
import type { PushKind, PushPayload, PushSubscriptionInput, ResolvedLanguage } from '@shared/api';

export const ICON = '/icons/icon-192.png';
/** Monochrome receipt on transparent: Android draws it in the status bar. */
export const BADGE = '/icons/badge-96.png';
/** Message the worker posts to an open window to route it in-app (see sw-register.ts). */
export const NAVIGATE_MESSAGE = 'tally:navigate';

export interface NotificationData {
  url: string;
  kind: PushKind | 'unknown';
  /** Reminder only: the local day "Skip today" refers to. */
  day?: string;
}

/** NotificationOptions plus the fields the TS DOM lib does not list yet. */
export type NotifyOptions = NotificationOptions & {
  actions?: Array<{ action: string; title: string }>;
  renotify?: boolean;
};

const KINDS: ReadonlySet<string> = new Set<PushKind>(['reminder', 'budget', 'weekly', 'monthly', 'test']);
const FALLBACK: PushPayload = { kind: 'test', title: 'Tally', body: '', url: '/', tag: 'tally', lang: 'en' };

/** Stands in for the worker's origin where only the shape of a path matters (any http(s) origin resolves alike). */
const ANY_ORIGIN = 'https://tally.invalid';

/**
 * An in-app path ("/overview?p=week"); anything that would leave the origin becomes "/". URL
 * parsers read "/\x" like "//x" (another host) and drop tabs and newlines ("/\t/x" is "//x" too),
 * so the pattern only screens the obvious cases and resolving the path decides.
 */
export function appPath(url: unknown, origin: string = ANY_ORIGIN): string {
  if (typeof url !== 'string' || !/^\/(?![/\\])/.test(url)) return '/';
  try {
    const base = new URL(origin);
    return new URL(url, base).origin === base.origin ? url : '/';
  } catch {
    return '/';
  }
}

const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value ? value : fallback);

/** The push message as sent by the Worker; a malformed one still shows something sensible. */
export function parsePayload(data: { json(): unknown; text(): string } | null): PushPayload {
  if (!data) return FALLBACK;
  let raw: unknown;
  try {
    raw = data.json();
  } catch {
    return { ...FALLBACK, body: data.text() };
  }
  if (typeof raw !== 'object' || raw === null) return FALLBACK;
  const p = raw as Partial<Record<keyof PushPayload, unknown>>;
  const actions = Array.isArray(p.actions)
    ? p.actions.filter((a): a is { action: 'log' | 'skip' | 'open'; title: string } => typeof a?.action === 'string' && typeof a?.title === 'string')
    : [];
  return {
    kind: typeof p.kind === 'string' && KINDS.has(p.kind) ? (p.kind as PushKind) : 'test',
    title: text(p.title, FALLBACK.title),
    body: text(p.body, ''),
    url: appPath(p.url),
    tag: text(p.tag, FALLBACK.tag),
    lang: p.lang === 'fr' ? 'fr' : 'en',
    ...(typeof p.day === 'string' ? { day: p.day } : {}),
    ...(actions.length ? { actions } : {}),
  };
}

/** showNotification arguments for a payload. */
export function notificationFor(p: PushPayload): { title: string; options: NotifyOptions } {
  const data: NotificationData = { url: p.url, kind: p.kind, ...(p.day ? { day: p.day } : {}) };
  return {
    title: p.title,
    options: {
      body: p.body,
      tag: p.tag,
      data,
      icon: ICON,
      badge: BADGE,
      lang: p.lang,
      // The tag replaces an older notification of the same kind quietly instead of buzzing again.
      renotify: false,
      ...(p.actions?.length ? { actions: p.actions.map((a) => ({ action: a.action, title: a.title })) } : {}),
    },
  };
}

export type ClickPlan = { kind: 'skip'; day: string | null } | { kind: 'open'; url: string };

/** "Skip today" records the skip and opens nothing; "Log now" opens the composer; else the payload's page. */
export function planClick(action: string, data: unknown): ClickPlan {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<NotificationData>;
  if (action === 'skip') return { kind: 'skip', day: typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? d.day : null };
  if (action === 'log') return { kind: 'open', url: '/?compose=1' };
  return { kind: 'open', url: appPath(d.url) };
}

export interface WindowLike {
  readonly url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface ClientsLike {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Focuses an open Tally window and routes it in-app (no reload, the person keeps their place),
 * or opens a new window on that page.
 */
export async function openApp(path: string, origin: string, clients: ClientsLike): Promise<void> {
  const target = new URL(appPath(path, origin), origin);
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((c) => new URL(c.url).origin === origin);
  if (!client) {
    await clients.openWindow(target.href);
    return;
  }
  // Focus can be refused (no user activation, e.g. a synthetic click); routing still happens.
  await client.focus().catch(() => undefined);
  client.postMessage({ type: NAVIGATE_MESSAGE, url: target.pathname + target.search });
}

/** POST /api/push/skip for a reminder's day. Failures are swallowed: the reminder is just a nudge. */
export async function skipDay(day: string | null, fetchFn: typeof fetch): Promise<void> {
  if (!day) return;
  await fetchFn('/api/push/skip', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day }),
  }).catch(() => undefined);
}

export function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  let s = '';
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The POST /api/push/subscribe body for a (re)newed subscription. */
export function subscriptionInput(
  sub: { endpoint: string; getKey(name: 'p256dh' | 'auth'): ArrayBuffer | null },
  lang: ResolvedLanguage,
  tz: string,
  userAgent: string,
): PushSubscriptionInput {
  return {
    subscription: { endpoint: sub.endpoint, keys: { p256dh: toBase64Url(sub.getKey('p256dh')), auth: toBase64Url(sub.getKey('auth')) } },
    user_agent: userAgent.slice(0, 500),
    lang,
    tz: tz || 'UTC',
  };
}
