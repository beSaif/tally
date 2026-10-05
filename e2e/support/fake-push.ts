/**
 * Fake Web Push for tests (headless Chromium has no push service): stubs Notification permission
 * and PushManager.subscribe/getSubscription with a real P-256 key pair, so the Worker can encrypt
 * for it and e2e/support/push-sink.ts can decrypt what it sends. The subscription's endpoint points
 * at that sink. State survives reloads (localStorage of the app's origin).
 */
import type { BrowserContext, Page } from '@playwright/test';

export interface FakePushState {
  permission?: NotificationPermission;
  sub?: { endpoint: string; p256dh: string; auth: string; privateJwk: JsonWebKey };
}

const STORE = '__tallyFakePush';

function fakePush(opts: { endpointBase: string }): void {
  const KEY = '__tallyFakePush';
  const load = (): FakePushState => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? 'null') as FakePushState | null) ?? {};
    } catch {
      return {};
    }
  };
  const save = (v: FakePushState) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
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
  const makeSub = (data: NonNullable<FakePushState['sub']>, serverKey: ArrayBuffer | null) => ({
    endpoint: data.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: serverKey },
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
    let lastServerKey: ArrayBuffer | null = null;
    proto.subscribe = async (options?: { applicationServerKey?: BufferSource | string | null }) => {
      const key = options?.applicationServerKey;
      if (key && typeof key !== 'string') lastServerKey = ArrayBuffer.isView(key) ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key;
      const s = load();
      if (!s.sub) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
        const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        s.sub = {
          endpoint: `${opts.endpointBase}${crypto.randomUUID()}`,
          p256dh: b64url(raw),
          auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
          privateJwk,
        };
        save(s);
      }
      return makeSub(s.sub, lastServerKey);
    };
    proto.getSubscription = async () => {
      const s = load();
      return s.sub ? makeSub(s.sub, lastServerKey) : null;
    };
    proto.permissionState = async () => (load().permission === 'granted' ? 'granted' : 'prompt');
  }
}

/** Installs the fake for every page of the context (call before navigating). */
export async function installFakePush(target: BrowserContext | Page, endpointBase: string): Promise<void> {
  await target.addInitScript(fakePush, { endpointBase });
}

/** What the fake stored for this origin ("this device"). */
export async function fakePushState(page: Page): Promise<FakePushState> {
  return page.evaluate((key) => {
    try {
      return (JSON.parse(localStorage.getItem(key) ?? 'null') as FakePushState | null) ?? {};
    } catch {
      return {};
    }
  }, STORE);
}
