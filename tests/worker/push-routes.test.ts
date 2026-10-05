import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { PushSubscriptionRow } from '@shared/api';
import { api, signup, type Session } from './helpers';
import { makeSubscriber, mockPushService, payloadsFor, subscriptionRow, type Subscriber } from './push-helpers';

let n = 0;
const endpoint = (label: string) => `https://push.example/sub/${label}-${++n}`;

function subscribeBody(sub: Subscriber, extra: { lang?: 'en' | 'fr'; tz?: string; user_agent?: string } = {}) {
  return {
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    user_agent: extra.user_agent ?? 'Mozilla/5.0 (iPhone)',
    lang: extra.lang ?? 'en',
    tz: extra.tz ?? 'Europe/Zurich',
  };
}

async function subscribe(s: Session, sub: Subscriber, extra: Parameters<typeof subscribeBody>[1] = {}): Promise<string> {
  const res = await api('/api/push/subscribe', { cookie: s.cookie, body: subscribeBody(sub, extra) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function list(s: Session): Promise<PushSubscriptionRow[]> {
  const res = await api('/api/push/subscriptions', { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as { subscriptions: PushSubscriptionRow[] }).subscriptions;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('push routes', () => {
  it('require a session', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['GET', '/api/push/vapid-public-key', undefined],
      ['GET', '/api/push/subscriptions', undefined],
      ['POST', '/api/push/subscribe', {}],
      ['PATCH', '/api/push/subscriptions/x', {}],
      ['DELETE', '/api/push/subscriptions/x', undefined],
      ['POST', '/api/push/test', {}],
      ['POST', '/api/push/skip', { day: '2026-10-05' }],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
  });

  it('serves the VAPID public key', async () => {
    const s = await signup();
    const res = await api('/api/push/vapid-public-key', { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: env.VAPID_PUBLIC_KEY });
  });

  it('upserts on the endpoint: subscribing again updates keys, language and zone', async () => {
    const s = await signup();
    const sub = await makeSubscriber(endpoint('upsert'));
    const id = await subscribe(s, sub, { lang: 'en', tz: 'Europe/Zurich' });
    await env.DB.prepare('UPDATE push_subscriptions SET failures = 3, last_seen_at = 1 WHERE id = ?').bind(id).run();

    const renewed = await makeSubscriber(sub.endpoint);
    const again = await subscribe(s, renewed, { lang: 'fr', tz: 'America/New_York' });
    expect(again).toBe(id);

    const rows = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ id, user_id: s.userId, lang: 'fr', tz: 'America/New_York', p256dh: renewed.p256dh, auth: renewed.auth, failures: 0 });
    expect(rows.results[0]?.last_seen_at).toBeGreaterThan(1);

    const listed = await list(s);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      id,
      endpoint: sub.endpoint,
      user_agent: 'Mozilla/5.0 (iPhone)',
      lang: 'fr',
      tz: 'America/New_York',
      created_at: expect.any(Number),
      last_seen_at: expect.any(Number),
    });
  });

  it('keeps at most ten devices per account, dropping the least recently seen', async () => {
    const s = await signup();
    const subs: Subscriber[] = [];
    for (let i = 0; i < 12; i++) {
      const sub = await makeSubscriber(endpoint(`cap${i}`));
      subs.push(sub);
      await subscribe(s, sub);
      // Distinct last_seen_at values so the order is unambiguous.
      await env.DB.prepare('UPDATE push_subscriptions SET last_seen_at = ? WHERE endpoint = ?').bind(1_000 + i, sub.endpoint).run();
    }
    const kept = (await list(s)).map((r) => r.endpoint).sort();
    expect(kept).toHaveLength(10);
    expect(kept).toEqual(subs.slice(2).map((x) => x.endpoint).sort());
    // Re-subscribing an old device brings it back and evicts the oldest kept one.
    await subscribe(s, subs[0]!);
    const after = (await list(s)).map((r) => r.endpoint);
    expect(after).toHaveLength(10);
    expect(after).toContain(subs[0]!.endpoint);
    expect(after).not.toContain(subs[2]!.endpoint);
  });

  it('lists only the caller’s devices', async () => {
    const a = await signup();
    const b = await signup();
    const a1 = await subscribe(a, await makeSubscriber(endpoint('a1')));
    const a2 = await subscribe(a, await makeSubscriber(endpoint('a2')), { user_agent: 'Firefox' });
    const b1 = await subscribe(b, await makeSubscriber(endpoint('b1')));
    expect((await list(a)).map((r) => r.id).sort()).toEqual([a1, a2].sort());
    expect((await list(b)).map((r) => r.id)).toEqual([b1]);
    expect((await list(a)).find((r) => r.id === a2)?.user_agent).toBe('Firefox');
  });

  it('hands an endpoint over to the account that subscribes it last', async () => {
    const a = await signup();
    const b = await signup();
    const sub = await makeSubscriber(endpoint('shared-device'));
    const id = await subscribe(a, sub);
    expect(await subscribe(b, sub, { lang: 'fr' })).toBe(id);
    expect(await list(a)).toEqual([]);
    expect((await list(b)).map((r) => [r.id, r.lang])).toEqual([[id, 'fr']]);
  });

  it('patches language and zone of the caller’s own devices only', async () => {
    const a = await signup();
    const b = await signup();
    const id = await subscribe(a, await makeSubscriber(endpoint('patch')), { lang: 'en', tz: 'UTC' });

    const res = await api(`/api/push/subscriptions/${id}`, { method: 'PATCH', cookie: a.cookie, body: { lang: 'fr' } });
    expect(res.status).toBe(204);
    expect(await subscriptionRow(id)).toMatchObject({ lang: 'fr', tz: 'UTC' });
    expect((await api(`/api/push/subscriptions/${id}`, { method: 'PATCH', cookie: a.cookie, body: { tz: 'Asia/Tokyo' } })).status).toBe(204);
    expect(await subscriptionRow(id)).toMatchObject({ lang: 'fr', tz: 'Asia/Tokyo' });

    const foreign = await api(`/api/push/subscriptions/${id}`, { method: 'PATCH', cookie: b.cookie, body: { lang: 'en' } });
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toBe('not_found');
    expect(await subscriptionRow(id)).toMatchObject({ lang: 'fr' });

    const missing = await api('/api/push/subscriptions/does-not-exist', { method: 'PATCH', cookie: a.cookie, body: { lang: 'en' } });
    expect(missing.status).toBe(404);
    const invalid = await api(`/api/push/subscriptions/${id}`, { method: 'PATCH', cookie: a.cookie, body: { lang: 'de' } });
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe('validation');
  });

  it('deletes the caller’s own devices; another user’s is not found', async () => {
    const a = await signup();
    const b = await signup();
    const id = await subscribe(a, await makeSubscriber(endpoint('delete')));

    const foreign = await api(`/api/push/subscriptions/${id}`, { method: 'DELETE', cookie: b.cookie });
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toBe('not_found');
    expect(await subscriptionRow(id)).not.toBeNull();

    expect((await api(`/api/push/subscriptions/${id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(204);
    expect(await subscriptionRow(id)).toBeNull();
    expect((await api(`/api/push/subscriptions/${id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(404);
  });

  it('records "skip today" idempotently', async () => {
    const s = await signup();
    expect((await api('/api/push/skip', { cookie: s.cookie, body: { day: '2026-10-05' } })).status).toBe(204);
    expect((await api('/api/push/skip', { cookie: s.cookie, body: { day: '2026-10-05' } })).status).toBe(204);
    const rows = await env.DB.prepare('SELECT day FROM reminder_skips WHERE user_id = ?').bind(s.userId).all<{ day: string }>();
    expect(rows.results).toEqual([{ day: '2026-10-05' }]);

    const bad = await api('/api/push/skip', { cookie: s.cookie, body: { day: '2026-02-30' } });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('validation');
  });

  it('validates subscriptions', async () => {
    const s = await signup();
    const sub = await makeSubscriber(endpoint('validate'));
    const bad = [
      { ...subscribeBody(sub), subscription: { endpoint: 'not a url', keys: { p256dh: sub.p256dh, auth: sub.auth } } },
      { ...subscribeBody(sub), lang: 'de' },
      { ...subscribeBody(sub), tz: '' },
      { subscription: { endpoint: sub.endpoint }, lang: 'en', tz: 'UTC' },
    ];
    for (const body of bad) {
      const res = await api('/api/push/subscribe', { cookie: s.cookie, body });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('validation');
    }
    const notJson = await api('/api/push/subscribe', { method: 'POST', cookie: s.cookie, raw: 'x', headers: { 'Content-Type': 'text/plain' } });
    expect(notJson.status).toBe(400);
    expect(await list(s)).toEqual([]);
  });

  it('sends a test notification to every device, with the Web Push headers', async () => {
    const s = await signup();
    const en = await makeSubscriber(endpoint('test-en'));
    const fr = await makeSubscriber(endpoint('test-fr'));
    await subscribe(s, en, { lang: 'en' });
    const frId = await subscribe(s, fr, { lang: 'fr' });
    await env.DB.prepare('UPDATE push_subscriptions SET failures = 2, last_seen_at = 5 WHERE id = ?').bind(frId).run();
    const calls = mockPushService(201);

    const res = await api('/api/push/test', { cookie: s.cookie, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2 });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.headers.get('TTL')).toBe('3600');
      expect(call.headers.get('Urgency')).toBe('normal');
      expect(call.headers.get('Content-Encoding')).toBe('aes128gcm');
      expect(call.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(call.headers.get('Authorization')).toMatch(/^vapid t=/);
      expect(call.headers.get('Authorization')).toContain(`, k=${env.VAPID_PUBLIC_KEY}`);
    }
    expect(await payloadsFor(calls, en)).toEqual([
      { kind: 'test', title: 'Notifications are on', body: 'This is how Tally will nudge you.', url: '/settings', tag: 'test', lang: 'en' },
    ]);
    expect(await payloadsFor(calls, fr)).toMatchObject([{ kind: 'test', title: 'Notifications activées', lang: 'fr' }]);
    // Both devices sit behind one push service: one VAPID signature (ECDSA is randomised) serves both.
    expect(calls[1]?.headers.get('Authorization')).toBe(calls[0]?.headers.get('Authorization'));
    // A delivered message resets the failure count, but is no sign the device is in use; tests are never logged.
    expect(await subscriptionRow(frId)).toMatchObject({ failures: 0, last_seen_at: 5 });
    const logged = await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_log WHERE user_id = ?').bind(s.userId).first<{ n: number }>();
    expect(logged?.n).toBe(0);
  });

  it('sends the test notification to one device when an endpoint is given', async () => {
    const s = await signup();
    const other = await signup();
    const one = await makeSubscriber(endpoint('test-one'));
    const two = await makeSubscriber(endpoint('test-two'));
    const foreign = await makeSubscriber(endpoint('test-foreign'));
    await subscribe(s, one);
    await subscribe(s, two);
    await subscribe(other, foreign);
    const calls = mockPushService(201);

    const res = await api('/api/push/test', { cookie: s.cookie, body: { endpoint: two.endpoint } });
    expect(await res.json()).toEqual({ sent: 1 });
    expect(calls.map((c) => c.url)).toEqual([two.endpoint]);

    // Someone else's device is never reached.
    const none = await api('/api/push/test', { cookie: s.cookie, body: { endpoint: foreign.endpoint } });
    expect(await none.json()).toEqual({ sent: 0 });
    expect(calls).toHaveLength(1);
  });

  it('drops a device the push service reports gone', async () => {
    const s = await signup();
    const gone = await makeSubscriber(endpoint('gone'));
    const alive = await makeSubscriber(endpoint('alive'));
    const goneId = await subscribe(s, gone);
    const aliveId = await subscribe(s, alive);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPushService((url) => (url === gone.endpoint ? 410 : 201));

    const res = await api('/api/push/test', { cookie: s.cookie, body: {} });
    expect(await res.json()).toEqual({ sent: 1 });
    expect(await subscriptionRow(goneId)).toBeNull();
    expect(await subscriptionRow(aliveId)).not.toBeNull();
  });
});
