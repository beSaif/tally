/**
 * Web Push on this device (spec §8.1): support detection, permission, PushManager subscription and
 * keeping the server's copy (language, time zone) current.
 */
import type { ResolvedLanguage } from '@shared/api';
import { api, isApiError } from './api';
import { fromBase64Url } from './sw-push';
import { isIOSDevice } from './ua';

export type PushSupport = { ok: true } | { ok: false; reason: 'unsupported' | 'ios-install' };
export type PushErrorCode = 'denied' | 'unsupported' | 'failed';

export class PushError extends Error {
  readonly code: PushErrorCode;
  constructor(code: PushErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PushError';
    this.code = code;
  }
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function isIOS(): boolean {
  return isIOSDevice(navigator.userAgent, navigator.platform ?? '', navigator.maxTouchPoints ?? 0);
}

/** iOS only delivers Web Push to apps added to the Home Screen, so there the answer is "install first". */
export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = isIOS();
  if (ios && !isStandalone()) return { ok: false, reason: 'ios-install' };
  if (!capable) return { ok: false, reason: ios ? 'ios-install' : 'unsupported' };
  return { ok: true };
}

export function permission(): NotificationPermission {
  return 'Notification' in window ? Notification.permission : 'denied';
}

const timeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (existing) return existing;
  // main.tsx registers the worker after load; give it a moment rather than failing at once.
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().ok) return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
}

// The server's id for this device's subscription: turning push off still works when the device
// list cannot be loaded.
const META_KEY = 'tally.push';
interface PushMeta {
  endpoint: string;
  id: string;
}

function readMeta(): PushMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as PushMeta) : null;
  } catch {
    return null;
  }
}

function writeMeta(meta: PushMeta | null): void {
  try {
    if (meta) localStorage.setItem(META_KEY, JSON.stringify(meta));
    else localStorage.removeItem(META_KEY);
  } catch {
    /* storage blocked: turning push off then relies on the device list */
  }
}

/** The service worker cannot read localStorage; it reads the language from this cache entry. */
export async function shareLanguageWithWorker(language: ResolvedLanguage): Promise<void> {
  try {
    if (!('caches' in window)) return;
    const cache = await caches.open('tally-meta');
    await cache.put('/__tally/meta', new Response(JSON.stringify({ lang: language }), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    /* best effort */
  }
}

function sameServerKey(current: ArrayBuffer | null | undefined, key: string): boolean {
  if (!current) return true; // unknown: assume it matches rather than churn subscriptions
  const a = new Uint8Array(current);
  const b = fromBase64Url(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function sync(sub: PushSubscription, language: ResolvedLanguage): Promise<string> {
  const json = sub.toJSON();
  const tz = timeZone();
  const { id } = await api.pushSubscribe({
    subscription: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } },
    user_agent: navigator.userAgent.slice(0, 500),
    lang: language,
    tz,
  });
  writeMeta({ endpoint: sub.endpoint, id });
  await shareLanguageWithWorker(language);
  return id;
}

/** Asks for permission, subscribes this browser and registers it with the server. */
export async function enablePush(language: ResolvedLanguage): Promise<{ id: string; endpoint: string }> {
  if (!pushSupport().ok) throw new PushError('unsupported');
  // Without a service worker nothing could receive a push: say so before asking for a permission
  // that could not be used.
  const reg = await registration();
  if (!reg) throw new PushError('unsupported');
  const result = await Notification.requestPermission();
  if (result !== 'granted') throw new PushError('denied');
  try {
    const { key } = await api.vapidKey();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameServerKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
    const id = await sync(sub, language);
    return { id, endpoint: sub.endpoint };
  } catch (err) {
    if (err instanceof PushError) throw err;
    throw new PushError('failed', err instanceof Error ? err.message : String(err));
  }
}

/**
 * This device's row on the server: the id stored when it last registered, else (no stored id, or
 * one for an endpoint the browser has since replaced) found by endpoint in the account's devices.
 */
async function serverId(sub: PushSubscription | null): Promise<string | null> {
  const meta = readMeta();
  if (meta && (!sub || meta.endpoint === sub.endpoint)) return meta.id;
  if (!sub) return null;
  const { subscriptions } = await api.pushSubscriptions();
  return subscriptions.find((r) => r.endpoint === sub.endpoint)?.id ?? null;
}

/**
 * Unsubscribes this browser and removes it from the server. The stored id is forgotten only once
 * the server has let go of the row, so a failed delete is retried by the next call (e.g. logout).
 */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  const id = await serverId(sub);
  if (sub) await sub.unsubscribe().catch(() => false);
  if (id) {
    await api.pushDelete(id).catch((err: unknown) => {
      // Already gone on the server is fine.
      if (!(isApiError(err) && err.code === 'not_found')) throw err;
    });
  }
  writeMeta(null);
}

/**
 * The account was deleted, and its device rows with it: only this browser's own subscription and
 * the stored id are left to drop. There is no session left to ask the server with, nor a need to.
 */
export async function unsubscribeLocally(): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (sub) await sub.unsubscribe().catch(() => false);
  writeMeta(null);
}

/**
 * On every start (and when the language changes): a subscribed device tells the server it is
 * alive, with its current language, time zone and user agent. The upsert is cheap, and the server
 * relies on it: last_seen_at picks the device whose zone budget alerts follow.
 */
export async function resyncPush(language: ResolvedLanguage): Promise<void> {
  if (!pushSupport().ok || permission() !== 'granted') return;
  const sub = await currentSubscription();
  if (!sub) return;
  await sync(sub, language).catch(() => undefined);
}
