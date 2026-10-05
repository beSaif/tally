/**
 * Turning push on and off on this device (src/app/lib/push.ts, spec §8.1), with the browser's
 * service worker, PushManager, Notification, localStorage and the API replaced by small fakes.
 * Every fake writes to `calls`, so the tests can check what happened in which order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disablePush, enablePush, PushError, unsubscribeLocally } from '@app/lib/push';
import { toBase64Url } from '@app/lib/sw-push';

const META = 'tally.push';
const VAPID = new Uint8Array(65).map((_, i) => (i * 7 + 4) % 256);
const ENDPOINT = 'https://push.example/device-1';

let calls: string[];
let storage: Map<string, string>;
let permissionAnswer: NotificationPermission;
let registered: boolean;
let browserSub: FakeSub | null;
let deviceRows: Array<{ id: string; endpoint: string }>;
let deleteStatus: number;

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}

function fakeSub(endpoint: string): FakeSub {
  return {
    endpoint,
    options: { applicationServerKey: VAPID.slice().buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BPk', auth: 'au' } }),
    unsubscribe: async () => {
      calls.push('unsubscribe');
      browserSub = null;
      return true;
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${url}`);
  if (method === 'GET' && url === '/api/push/vapid-public-key') return json({ key: toBase64Url(VAPID.buffer) });
  if (method === 'POST' && url === '/api/push/subscribe') return json({ id: 'row-new' });
  if (method === 'GET' && url === '/api/push/subscriptions') return json({ subscriptions: deviceRows });
  if (method === 'DELETE' && url.startsWith('/api/push/subscriptions/')) {
    if (deleteStatus === 204) return new Response(null, { status: 204 });
    return json({ error: { code: deleteStatus === 404 ? 'not_found' : 'internal', message: 'no' } }, deleteStatus);
  }
  return json({ error: { code: 'not_found', message: url } }, 404);
}

const registration = {
  pushManager: {
    getSubscription: async () => browserSub,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      calls.push(`subscribe ${toBase64Url(options.applicationServerKey.slice().buffer)}`);
      browserSub = fakeSub(ENDPOINT);
      return browserSub;
    },
  },
};

const meta = () => {
  const raw = storage.get(META);
  return raw ? (JSON.parse(raw) as { endpoint: string; id: string }) : null;
};

beforeEach(() => {
  calls = [];
  storage = new Map();
  permissionAnswer = 'granted';
  registered = true;
  browserSub = null;
  deviceRows = [];
  deleteStatus = 204;
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    language: 'en-CH',
    serviceWorker: {
      getRegistration: async () => {
        calls.push('getRegistration');
        return registered ? registration : undefined;
      },
      // A worker that never becomes ready (none was registered).
      ready: new Promise(() => undefined),
    },
  });
  const Notification = {
    permission: 'default',
    requestPermission: async () => {
      calls.push('requestPermission');
      return permissionAnswer;
    },
  };
  vi.stubGlobal('Notification', Notification);
  vi.stubGlobal('window', { PushManager: class {}, Notification, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('enablePush', () => {
  it('finds the service worker, then asks for permission, subscribes with the server key and registers', async () => {
    await expect(enablePush('en')).resolves.toEqual({ id: 'row-new', endpoint: ENDPOINT });
    expect(calls).toEqual([
      'getRegistration',
      'requestPermission',
      'GET /api/push/vapid-public-key',
      `subscribe ${toBase64Url(VAPID.buffer)}`,
      'POST /api/push/subscribe',
    ]);
    expect(meta()).toEqual({ endpoint: ENDPOINT, id: 'row-new' });
  });

  it('does not ask for permission when no service worker could receive a push', async () => {
    vi.useFakeTimers();
    registered = false;
    const result = enablePush('en').catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(4000);
    const err = await result;
    expect(err).toBeInstanceOf(PushError);
    expect(err).toMatchObject({ code: 'unsupported' });
    expect(calls).toEqual(['getRegistration']);
  });

  it('stops when permission is refused', async () => {
    permissionAnswer = 'denied';
    await expect(enablePush('en')).rejects.toMatchObject({ code: 'denied' });
    expect(calls).toEqual(['getRegistration', 'requestPermission']);
    expect(meta()).toBeNull();
  });
});

describe('disablePush', () => {
  it('uses the stored id, unsubscribes the browser, then removes the row; the id is forgotten last', async () => {
    browserSub = fakeSub(ENDPOINT);
    storage.set(META, JSON.stringify({ endpoint: ENDPOINT, id: 'row-1' }));
    await disablePush();
    expect(calls).toEqual(['getRegistration', 'unsubscribe', 'DELETE /api/push/subscriptions/row-1']);
    expect(meta()).toBeNull();
  });

  it('keeps the stored id when the server delete fails, and the next call retries it', async () => {
    browserSub = fakeSub(ENDPOINT);
    storage.set(META, JSON.stringify({ endpoint: ENDPOINT, id: 'row-1' }));
    deleteStatus = 503;
    await expect(disablePush()).rejects.toMatchObject({ code: 'internal' });
    expect(browserSub).toBeNull();
    expect(meta()).toEqual({ endpoint: ENDPOINT, id: 'row-1' });

    deleteStatus = 204;
    calls = [];
    await disablePush();
    expect(calls).toEqual(['getRegistration', 'DELETE /api/push/subscriptions/row-1']);
    expect(meta()).toBeNull();
  });

  it('treats a row the server no longer has as removed', async () => {
    browserSub = fakeSub(ENDPOINT);
    storage.set(META, JSON.stringify({ endpoint: ENDPOINT, id: 'row-1' }));
    deleteStatus = 404;
    await disablePush();
    expect(meta()).toBeNull();
  });

  it('looks the device up by endpoint only when no id for this endpoint is stored', async () => {
    browserSub = fakeSub(ENDPOINT);
    deviceRows = [
      { id: 'row-other', endpoint: 'https://push.example/other' },
      { id: 'row-2', endpoint: ENDPOINT },
    ];
    await disablePush();
    expect(calls).toEqual(['getRegistration', 'GET /api/push/subscriptions', 'unsubscribe', 'DELETE /api/push/subscriptions/row-2']);

    // An id stored for an endpoint the browser has since replaced is not this device's row.
    browserSub = fakeSub(ENDPOINT);
    storage.set(META, JSON.stringify({ endpoint: 'https://push.example/old', id: 'row-old' }));
    calls = [];
    await disablePush();
    expect(calls).toEqual(['getRegistration', 'GET /api/push/subscriptions', 'unsubscribe', 'DELETE /api/push/subscriptions/row-2']);
    expect(meta()).toBeNull();
  });

  it('changes nothing when the device cannot be looked up', async () => {
    browserSub = fakeSub(ENDPOINT);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(disablePush()).rejects.toMatchObject({ code: 'offline' });
    expect(browserSub).not.toBeNull();
  });

  it('does nothing without a subscription or a stored id', async () => {
    await disablePush();
    expect(calls).toEqual(['getRegistration']);
  });
});

describe('unsubscribeLocally', () => {
  it('drops the browser subscription and the stored id without asking the server', async () => {
    browserSub = fakeSub(ENDPOINT);
    storage.set(META, JSON.stringify({ endpoint: ENDPOINT, id: 'row-1' }));
    await unsubscribeLocally();
    expect(calls).toEqual(['getRegistration', 'unsubscribe']);
    expect(meta()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
