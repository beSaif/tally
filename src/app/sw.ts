/// <reference lib="webworker" />
// Service worker: precache (Workbox injectManifest) + SPA navigation fallback + Web Push (spec §8.1, §9).
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import type { ResolvedLanguage } from '@shared/api';
import { fromBase64Url, notificationFor, openApp, parsePayload, planClick, skipDay, subscriptionInput } from './lib/sw-push';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Navigations (except the API) get the app shell, so the app opens offline. /api/* is never cached.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

// The page's "Update ready · RELOAD" toast asks the waiting worker to take over.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

/** Extends the event's lifetime; a synthetic event (tests) cannot be extended, but the work still runs. */
function keepAlive(event: ExtendableEvent, work: Promise<unknown>): void {
  try {
    event.waitUntil(work);
  } catch {
    void work;
  }
}

self.addEventListener('push', (event) => {
  const { title, options } = notificationFor(parsePayload(event.data));
  keepAlive(event, self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const plan = planClick(event.action, event.notification.data);
  keepAlive(event, plan.kind === 'skip' ? skipDay(plan.day, fetch) : openApp(plan.url, self.location.origin, self.clients));
});

/** The page keeps its resolved language in this cache entry (a worker cannot read localStorage). */
async function storedLanguage(): Promise<ResolvedLanguage> {
  try {
    const res = await (await caches.open('tally-meta')).match('/__tally/meta');
    const meta = res ? ((await res.json()) as { lang?: unknown }) : null;
    if (meta?.lang === 'fr' || meta?.lang === 'en') return meta.lang;
  } catch {
    /* fall through to the worker's own language */
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

// The push service rotated or dropped the subscription: subscribe again and tell the Worker.
self.addEventListener('pushsubscriptionchange', (event) => {
  const change = event as PushSubscriptionChangeEvent;
  keepAlive(
    change,
    (async () => {
      const sub =
        change.newSubscription ??
        (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: await serverKey(change.oldSubscription) }));
      const body = subscriptionInput(sub, await storedLanguage(), Intl.DateTimeFormat().resolvedOptions().timeZone, self.navigator.userAgent);
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    })().catch(() => undefined),
  );
});
