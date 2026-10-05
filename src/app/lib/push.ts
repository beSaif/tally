/**
 * Web Push on this device (spec §8.1): support detection, permission, PushManager subscription and
 * keeping the server's copy (language, time zone) current.
 */
import type { PushSubscriptionRow, ResolvedLanguage } from '@shared/api';
import { api } from './api';
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

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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
  const b = urlBase64ToUint8Array(key);
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
  const result = await Notification.requestPermission();
  if (result !== 'granted') throw new PushError('denied');
  const reg = await registration();
  if (!reg) throw new PushError('unsupported');
  try {
    const { key } = await api.vapidKey();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameServerKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    const id = await sync(sub, language);
    return { id, endpoint: sub.endpoint };
  } catch (err) {
    if (err instanceof PushError) throw err;
    throw new PushError('failed', err instanceof Error ? err.message : String(err));
  }
}

/** Unsubscribes this browser and removes it from the server. */
export async function disablePush(rows: readonly PushSubscriptionRow[]): Promise<void> {
  const sub = await currentSubscription();
  const id = rows.find((r) => sub && r.endpoint === sub.endpoint)?.id ?? readMeta()?.id;
  if (sub) await sub.unsubscribe().catch(() => false);
  writeMeta(null);
  if (id) {
    await api.pushDelete(id).catch((err: unknown) => {
      // Already gone on the server is fine.
      if (!(err instanceof Error && 'code' in err && (err as { code: string }).code === 'not_found')) throw err;
    });
  }
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
