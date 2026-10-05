/**
 * Service worker registration (production only) and the "Update ready · RELOAD" flow:
 * a new worker waits; RELOAD tells it to skip waiting and the page reloads on `controllerchange`.
 * Notification clicks from the worker arrive as NAVIGATE_MESSAGE messages and route in-app.
 */
import { navigate } from '../router';
import { translate, lang } from '../i18n';
import { NAVIGATE_MESSAGE } from './sw-push';
import { showToast } from './toast';
import { onAppVisible } from './visible';

let reloadRequested = false;

/** Shows the update toast for a waiting worker (also used by the dev hook to preview it). */
export function announceUpdate(worker: ServiceWorker | null): void {
  showToast({
    text: translate(lang.value, 'toast.updateReady'),
    actionLabel: translate(lang.value, 'toast.reload'),
    sticky: true,
    onAction: () => {
      reloadRequested = true;
      if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
      else location.reload();
    },
  });
}

function listenForMessages(): void {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === NAVIGATE_MESSAGE && typeof data.url === 'string') {
      const url = new URL(data.url, location.origin);
      if (url.origin === location.origin) navigate(url.pathname + url.search);
    }
  });
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  listenForMessages();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    location.reload();
  });
  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      if (reg.waiting && navigator.serviceWorker.controller) announceUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        incoming?.addEventListener('statechange', () => {
          // Only an *update* waits: the very first install has no controller yet.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) announceUpdate(incoming);
        });
      });
      // Long-lived tabs (an installed PWA) still learn about new versions.
      onAppVisible(() => void reg.update().catch(() => undefined));
    } catch {
      /* no worker (blocked, private mode): the app still works online */
    }
  };
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}
