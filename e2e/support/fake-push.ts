/**
 * Fake Web Push for tests (headless Chromium has no push service): stubs Notification permission
 * and PushManager.subscribe/getSubscription with a real P-256 key so the server can encrypt for it.
 * State survives reloads (localStorage). Without a service worker registration (Vite dev server)
 * `getRegistration()` hands out a stand-in registration.
 */
import type { BrowserContext, Page } from '@playwright/test';

function fakePush(): void {
  const STORE = '__tallyFakePush';
  type Stored = { permission?: NotificationPermission; sub?: { endpoint: string; p256dh: string; auth: string } };
  const load = (): Stored => {
    try {
      return (JSON.parse(localStorage.getItem(STORE) ?? 'null') as Stored | null) ?? {};
    } catch {
      return {};
    }
  };
  const save = (v: Stored) => {
    try {
      localStorage.setItem(STORE, JSON.stringify(v));
    } catch {
      /* opaque origins (about:blank) have no storage */
    }
  };
  const b64url = (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const unb64url = (s: string) => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  };
  const makeSub = (data: NonNullable<Stored['sub']>) => ({
    endpoint: data.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: (name: string) => unb64url(name === 'p256dh' ? data.p256dh : data.auth),
    toJSON: () => ({ endpoint: data.endpoint, expirationTime: null, keys: { p256dh: data.p256dh, auth: data.auth } }),
    unsubscribe: async () => {
      const s = load();
      delete s.sub;
      save(s);
      return true;
    },
  });

  if (typeof Notification !== 'undefined') {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => load().permission ?? 'default' });
    Notification.requestPermission = async () => {
      const s = load();
      s.permission = 'granted';
      save(s);
      return 'granted';
    };
  }
  if (typeof PushManager !== 'undefined') {
    const proto = PushManager.prototype as unknown as Record<string, unknown>;
    proto.subscribe = async () => {
      const s = load();
      if (!s.sub) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
        s.sub = { endpoint: `https://push.example.test/send/${crypto.randomUUID()}`, p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
        save(s);
      }
      return makeSub(s.sub);
    };
    proto.getSubscription = async () => {
      const s = load();
      return s.sub ? makeSub(s.sub) : null;
    };
    proto.permissionState = async () => (load().permission === 'granted' ? 'granted' : 'prompt');
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof PushManager !== 'undefined') {
    const standIn = { scope: `${location.origin}/`, pushManager: Object.create(PushManager.prototype) as PushManager };
    const container = ServiceWorkerContainer.prototype as unknown as { getRegistration: (...a: unknown[]) => Promise<unknown> };
    const real = container.getRegistration;
    container.getRegistration = async function (this: ServiceWorkerContainer, ...args: unknown[]) {
      const found = await real.apply(this, args).catch(() => undefined);
      return found ?? standIn;
    };
  }
}

/** Installs the fake for every page of the context (call before navigating). */
export async function installFakePush(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript(fakePush);
}

/** Whatever the fake stored for this origin (endpoint of "this device"). */
export async function fakeEndpoint(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      const s = JSON.parse(localStorage.getItem('__tallyFakePush') ?? 'null') as { sub?: { endpoint: string } } | null;
      return s?.sub?.endpoint ?? null;
    } catch {
      return null;
    }
  });
}
