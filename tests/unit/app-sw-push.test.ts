import { describe, expect, it, vi } from 'vitest';
import {
  BADGE,
  ICON,
  NAVIGATE_MESSAGE,
  appPath,
  fromBase64Url,
  notificationFor,
  openApp,
  parsePayload,
  planClick,
  skipDay,
  subscriptionInput,
  toBase64Url,
  type ClientsLike,
  type WindowLike,
} from '@app/lib/sw-push';

const data = (value: unknown) => ({
  json: () => (typeof value === 'string' ? JSON.parse(value) : value),
  text: () => (typeof value === 'string' ? value : JSON.stringify(value)),
});

const REMINDER = {
  kind: 'reminder',
  title: 'Anything spent today?',
  body: 'One sentence is enough.',
  url: '/?compose=1',
  tag: 'reminder',
  lang: 'en',
  day: '2026-10-05',
  actions: [
    { action: 'log', title: 'Log now' },
    { action: 'skip', title: 'Skip today' },
  ],
};

describe('parsePayload', () => {
  it('keeps a well-formed payload', () => {
    expect(parsePayload(data(REMINDER))).toEqual(REMINDER);
  });

  it('shows something sensible for a missing, odd or non-JSON message', () => {
    expect(parsePayload(null)).toMatchObject({ title: 'Tally', url: '/', kind: 'test' });
    expect(parsePayload(data('just text'))).toMatchObject({ title: 'Tally', body: 'just text' });
    expect(parsePayload(data({ kind: 'nope', title: '', lang: 'de', actions: [{ action: 'log' }] }))).toEqual({
      kind: 'test',
      title: 'Tally',
      body: '',
      url: '/',
      tag: 'tally',
      lang: 'en',
    });
  });

  it('only ever opens paths of this app', () => {
    expect(parsePayload(data({ ...REMINDER, url: 'https://evil.example/' })).url).toBe('/');
    expect(parsePayload(data({ ...REMINDER, url: '//evil.example/x' })).url).toBe('/');
    expect(appPath('/overview?p=week')).toBe('/overview?p=week');
    expect(appPath(42)).toBe('/');
  });
});

describe('appPath', () => {
  const origin = 'https://tally.example.workers.dev';

  it('keeps paths of this app', () => {
    expect(appPath('/overview?p=week')).toBe('/overview?p=week');
    expect(appPath('/overview?p=week', origin)).toBe('/overview?p=week');
    expect(appPath('/?compose=1', origin)).toBe('/?compose=1');
    expect(appPath('/x\\y', origin)).toBe('/x\\y');
  });

  it('turns anything that resolves to another origin into "/"', () => {
    for (const url of ['/\\evil.example/x', '//evil.example', '/\\evil', 'https://evil.example', '/\t/evil.example', '/\n/evil.example', ' //evil', '', 'overview']) {
      expect(appPath(url), JSON.stringify(url)).toBe('/');
      expect(appPath(url, origin), JSON.stringify(url)).toBe('/');
    }
    expect(appPath(null)).toBe('/');
  });

  it('applies to payloads and clicks too', () => {
    expect(parsePayload(data({ ...REMINDER, url: '/\\evil.example/x' })).url).toBe('/');
    expect(planClick('', { url: '/\\evil.example/x' })).toEqual({ kind: 'open', url: '/' });
  });
});

describe('notificationFor', () => {
  it('builds the showNotification options of spec §8.1', () => {
    const { title, options } = notificationFor(parsePayload(data(REMINDER)));
    expect(title).toBe('Anything spent today?');
    expect(options).toEqual({
      body: 'One sentence is enough.',
      tag: 'reminder',
      data: { url: '/?compose=1', kind: 'reminder', day: '2026-10-05' },
      icon: ICON,
      badge: BADGE,
      lang: 'en',
      renotify: true,
      actions: REMINDER.actions,
    });
  });

  it('has no actions or day when the payload has none', () => {
    const { options } = notificationFor(parsePayload(data({ kind: 'weekly', title: 'Last week', body: '', url: '/overview?p=week', tag: 'weekly', lang: 'fr' })));
    expect(options.actions).toBeUndefined();
    expect(options.data).toEqual({ url: '/overview?p=week', kind: 'weekly' });
    expect(options.lang).toBe('fr');
  });
});

describe('planClick', () => {
  const d = { url: '/?compose=1', kind: 'reminder', day: '2026-10-05' };
  it('Skip today records the day and opens nothing', () => {
    expect(planClick('skip', d)).toEqual({ kind: 'skip', day: '2026-10-05' });
    expect(planClick('skip', { url: '/' })).toEqual({ kind: 'skip', day: null });
  });
  it('Log now opens the composer; anything else opens the notification page', () => {
    expect(planClick('log', d)).toEqual({ kind: 'open', url: '/?compose=1' });
    expect(planClick('', { url: '/overview?p=month' })).toEqual({ kind: 'open', url: '/overview?p=month' });
    expect(planClick('open', { url: 'https://evil.example' })).toEqual({ kind: 'open', url: '/' });
    expect(planClick('', null)).toEqual({ kind: 'open', url: '/' });
  });
});

describe('openApp', () => {
  const origin = 'https://tally.example.workers.dev';
  const win = (url: string, focus: () => Promise<unknown> = () => Promise.resolve()): WindowLike & { messages: unknown[] } => {
    const messages: unknown[] = [];
    return { url, focus, postMessage: (m: unknown) => messages.push(m), messages };
  };
  const clientsWith = (windows: WindowLike[]): ClientsLike & { opened: string[] } => {
    const opened: string[] = [];
    return { matchAll: async () => windows, openWindow: async (url: string) => opened.push(url), opened };
  };

  it('focuses an open window and routes it in-app', async () => {
    const other = win('https://elsewhere.example/');
    const mine = win(`${origin}/overview`);
    const focus = vi.fn(() => Promise.resolve());
    mine.focus = focus;
    const clients = clientsWith([other, mine]);
    await openApp('/?compose=1', origin, clients);
    expect(focus).toHaveBeenCalledOnce();
    expect(mine.messages).toEqual([{ type: NAVIGATE_MESSAGE, url: '/?compose=1' }]);
    expect(other.messages).toEqual([]);
    expect(clients.opened).toEqual([]);
  });

  it('still routes when focusing is refused', async () => {
    const mine = win(`${origin}/`, () => Promise.reject(new Error('InvalidAccessError')));
    await openApp('/settings', origin, clientsWith([mine]));
    expect(mine.messages).toEqual([{ type: NAVIGATE_MESSAGE, url: '/settings' }]);
  });

  it('opens a new window when none is open', async () => {
    const clients = clientsWith([]);
    await openApp('/overview?p=week', origin, clients);
    expect(clients.opened).toEqual([`${origin}/overview?p=week`]);
  });

  it('never opens or routes to another origin', async () => {
    const clients = clientsWith([]);
    await openApp('/\\evil.example/x', origin, clients);
    expect(clients.opened).toEqual([`${origin}/`]);
    const mine = win(`${origin}/`);
    await openApp('/\t/evil.example', origin, clientsWith([mine]));
    expect(mine.messages).toEqual([{ type: NAVIGATE_MESSAGE, url: '/' }]);
  });
});

describe('skipDay', () => {
  it('POSTs the day as JSON', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await skipDay('2026-10-05', fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith('/api/push/skip', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{"day":"2026-10-05"}',
    });
  });

  it('does nothing without a day and never throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await skipDay(null, fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(skipDay('2026-10-05', fetchFn as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe('subscriptionInput', () => {
  it('encodes the keys as base64url and caps the user agent', () => {
    const p256dh = new Uint8Array([4, 255, 254, 253]).buffer;
    const auth = new Uint8Array([251, 0, 63]).buffer;
    const body = subscriptionInput({ endpoint: 'https://push.example/1', getKey: (n) => (n === 'p256dh' ? p256dh : auth) }, 'fr', '', 'x'.repeat(600));
    expect(body).toEqual({
      subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'BP_-_Q', auth: '-wA_' } },
      user_agent: 'x'.repeat(500),
      lang: 'fr',
      tz: 'UTC',
    });
  });

  it('base64url round-trips', () => {
    const bytes = new Uint8Array(65).map((_, i) => (i * 37) % 256);
    expect([...fromBase64Url(toBase64Url(bytes.buffer))]).toEqual([...bytes]);
    expect(toBase64Url(null)).toBe('');
  });
});
