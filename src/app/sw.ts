/// <reference lib="webworker" />
// Service worker: precache (Workbox injectManifest) + SPA navigation fallback + Web Push (spec §8.1, §9).
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import type { PushPayload, PushSubscriptionInput, ResolvedLanguage } from '@shared/api';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Navigations (except the API) get the app shell. /api/* is never cached.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

// ---------------------------------------------------------------- push

/** Notification options the TS DOM lib does not list yet (actions, renotify). */
type NotifyOptions = NotificationOptions & {
  actions?: Array<{ action: string; title: string }>;
  renotify?: boolean;
};

interface NotificationData {
  url: string;
  kind: PushPayload['kind'] | 'unknown';
  day?: string;
}

function parsePayload(data: PushMessageData | null): PushPayload {
  const fallback: PushPayload = { kind: 'test', title: 'Tally', body: '', url: '/', tag: 'tally', lang: 'en' };
  if (!data) return fallback;
  try {
    const raw = data.json() as Partial<PushPayload>;
    return {
      ...fallback,
      ...raw,
      title: typeof raw.title === 'string' && raw.title ? raw.title : fallback.title,
      url: typeof raw.url === 'string' && raw.url.startsWith('/') ? raw.url : '/',
    };
  } catch {
    return { ...fallback, body: data.text() };
  }
}

self.addEventListener('push', (event) => {
  const p = parsePayload(event.data);
  const data: NotificationData = { url: p.url, kind: p.kind, ...(p.day ? { day: p.day } : {}) };
  const options: NotifyOptions = {
    body: p.body,
    tag: p.tag,
    data,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: p.lang,
    renotify: false,
    ...(p.actions?.length ? { actions: p.actions.map((a) => ({ action: a.action, title: a.title })) } : {}),
  };
  event.waitUntil(self.registration.showNotification(p.title, options));
});

/** Focus an open Tally window and route it in-app (no reload), else open a new one. */
async function openApp(url: string): Promise<void> {
  const target = new URL(url, self.location.origin);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (client) {
    await client.focus().catch(() => undefined);
    client.postMessage({ type: 'tally:navigate', url: target.pathname + target.search });
    return;
  }
  await self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = (notification.data ?? {}) as Partial<NotificationData>;
  notification.close();
  if (event.action === 'skip') {
    // "Skip today": no reminder for that day; nothing to open.
    event.waitUntil(
      fetch('/api/push/skip', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: data.day }),
      }).then(
        () => undefined,
        () => undefined,
      ),
    );
    return;
  }
  const url = event.action === 'log' ? '/?compose=1' : data.url || '/';
  event.waitUntil(openApp(url));
});

// ---------------------------------------------------------------- subscription renewal

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  let s = '';
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The page stores its language in this cache entry (a worker cannot read localStorage). */
async function storedLanguage(): Promise<ResolvedLanguage> {
  try {
    const res = await (await caches.open('tally-meta')).match('/__tally/meta');
    const meta = res ? ((await res.json()) as { lang?: string }) : null;
    if (meta?.lang === 'fr' || meta?.lang === 'en') return meta.lang;
  } catch {
    /* fall through */
  }
  return self.navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

async function serverKey(old: PushSubscription | null): Promise<BufferSource> {
  const fromOld = old?.options?.applicationServerKey;
  if (fromOld) return fromOld;
  const res = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
  const { key } = (await res.json()) as { key: string };
  return fromBase64Url(key);
}

self.addEventListener('pushsubscriptionchange', (event) => {
  const change = event as PushSubscriptionChangeEvent;
  change.waitUntil(
    (async () => {
      const sub =
        change.newSubscription ??
        (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: await serverKey(change.oldSubscription) }));
      const body: PushSubscriptionInput = {
        subscription: { endpoint: sub.endpoint, keys: { p256dh: toBase64Url(sub.getKey('p256dh')), auth: toBase64Url(sub.getKey('auth')) } },
        user_agent: self.navigator.userAgent.slice(0, 500),
        lang: await storedLanguage(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    })().catch(() => undefined),
  );
});
