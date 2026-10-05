import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { zonedParts } from '@shared/dates';
import { loadSubscriptions, maybeSendBudgetAlerts, runBudgetAlerts, sendToSubscriptions } from '../../src/worker/push/notify';
import { addEntries, addSubscription, logKeys, makeSubscriber, mockPushService, payloadsFor, resetDb, seedUser, subscriptionRow } from './push-helpers';

const NNBSP = ' ';
const NOW = new Date('2026-10-14T10:00:00Z'); // 14 Oct, 12:00 in Zurich: 17 days left in the month

let n = 0;
const endpoint = (label: string) => `https://push.example/sub/${label}-${++n}`;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function budgetUser(settings: Parameters<typeof seedUser>[0] = { budget_cents: 200_000 }, lang: 'en' | 'fr' = 'en') {
  const userId = await seedUser(settings);
  const sub = await makeSubscriber(endpoint('budget'));
  await addSubscription(userId, sub, { tz: 'Europe/Zurich', lang });
  return { userId, sub };
}

describe('budget alerts', () => {
  it('alerts once per threshold: 50% first, then only 80%', async () => {
    const { userId, sub } = await budgetUser();
    await addEntries(userId, [
      { amount_cents: 100_000, occurred_at: '2026-10-02T12:00' },
      { amount_cents: 2_000, occurred_at: '2026-10-14T11:00' },
      // Last month does not count towards this month's budget.
      { amount_cents: 90_000, occurred_at: '2026-09-30T12:00' },
    ]);
    const calls = mockPushService(201);

    expect(await runBudgetAlerts(env, userId, '2026-10-14T11:00', NOW)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('Urgency')).toBe('high');
    expect(calls[0]?.headers.get('TTL')).toBe('86400');
    expect(await payloadsFor(calls, sub)).toEqual([
      {
        kind: 'budget',
        title: 'Halfway through your budget',
        body: `1${NNBSP}020.00 of 2${NNBSP}000 CHF · 17 days left`,
        url: '/overview?p=month',
        tag: 'budget',
        lang: 'en',
      },
    ]);
    expect(await logKeys(userId, 'budget')).toEqual(['2026-10:50']);

    // Nothing new crossed: nothing sent.
    expect(await runBudgetAlerts(env, userId, '2026-10-14T11:00', NOW)).toBe(0);
    expect(calls).toHaveLength(1);

    await addEntries(userId, [{ amount_cents: 68_000, occurred_at: '2026-10-14T12:00' }]); // 1 700.00
    expect(await runBudgetAlerts(env, userId, '2026-10-14T12:00', NOW)).toBe(1);
    expect(calls).toHaveLength(2);
    const [, second] = await payloadsFor(calls, sub);
    expect(second).toMatchObject({ kind: 'budget', title: '80% of your budget', body: `1${NNBSP}700.00 of 2${NNBSP}000 CHF · 17 days left` });
    expect(await logKeys(userId, 'budget')).toEqual(['2026-10:50', '2026-10:80']);
  });

  it('sends only the highest threshold when several are crossed at once, and logs them all', async () => {
    const { userId, sub } = await budgetUser({ budget_cents: 200_000 }, 'fr');
    await addEntries(userId, [{ amount_cents: 210_000, occurred_at: '2026-10-14T09:00' }]);
    const calls = mockPushService(201);

    expect(await runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW)).toBe(1);
    expect(await payloadsFor(calls, sub)).toEqual([
      {
        kind: 'budget',
        title: 'Budget atteint',
        body: `2${NNBSP}100.00 sur 2${NNBSP}000 CHF · 17 jours restants`,
        url: '/overview?p=month',
        tag: 'budget',
        lang: 'fr',
      },
    ]);
    expect(await logKeys(userId, 'budget')).toEqual(['2026-10:100', '2026-10:50', '2026-10:80']);
  });

  it('sends one alert when two saves race', async () => {
    const { userId } = await budgetUser();
    await addEntries(userId, [{ amount_cents: 120_000, occurred_at: '2026-10-14T09:00' }]);
    const calls = mockPushService(201);
    const sent = await Promise.all([
      runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW),
      runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW),
    ]);
    expect(sent.sort()).toEqual([0, 1]);
    expect(calls).toHaveLength(1);
  });

  it('stays quiet without a budget, when turned off, below 50%, for other months, or without devices', async () => {
    const calls = mockPushService(201);
    const cases: Array<{ settings: Parameters<typeof seedUser>[0]; occurredAt: string; device?: boolean }> = [
      { settings: { budget_cents: null }, occurredAt: '2026-10-14T09:00' },
      { settings: { budget_cents: 0 }, occurredAt: '2026-10-14T09:00' },
      { settings: { budget_cents: 200_000, notif_budget: 0 }, occurredAt: '2026-10-14T09:00' },
      { settings: { budget_cents: 300_000 }, occurredAt: '2026-10-14T09:00' }, // 1 200.00 is 40%
      { settings: { budget_cents: 200_000 }, occurredAt: '2026-09-30T09:00' }, // edited an entry of last month
      { settings: { budget_cents: 200_000 }, occurredAt: '2026-10-14T09:00', device: false },
    ];
    for (const c of cases) {
      const userId = await seedUser(c.settings);
      if (c.device !== false) await addSubscription(userId, await makeSubscriber(endpoint('quiet')), { tz: 'Europe/Zurich' });
      await addEntries(userId, [
        { amount_cents: 120_000, occurred_at: '2026-10-14T09:00' },
        { amount_cents: 150_000, occurred_at: '2026-09-30T09:00' },
      ]);
      expect(await runBudgetAlerts(env, userId, c.occurredAt, NOW), JSON.stringify(c)).toBe(0);
      expect(await logKeys(userId, 'budget')).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it('gives the thresholds back when no device took the alert, so the next write retries', async () => {
    const { userId, sub } = await budgetUser();
    await addEntries(userId, [{ amount_cents: 170_000, occurred_at: '2026-10-14T09:00' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let status = 503;
    const calls = mockPushService(() => status);

    expect(await runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await logKeys(userId, 'budget')).toEqual([]);

    status = 201;
    expect(await runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW)).toBe(1);
    expect((await payloadsFor(calls, sub)).map((p) => p.title)).toEqual(['80% of your budget', '80% of your budget']);
    expect(await logKeys(userId, 'budget')).toEqual(['2026-10:50', '2026-10:80']);
  });

  it('keeps the thresholds when every device is gone: there is no one to retry for', async () => {
    const { userId } = await budgetUser();
    await addEntries(userId, [{ amount_cents: 120_000, occurred_at: '2026-10-14T09:00' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPushService(410);

    expect(await runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW)).toBe(0);
    expect(await logKeys(userId, 'budget')).toEqual(['2026-10:50']);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').bind(userId).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('keeps the alert for later when push is not configured yet', async () => {
    const { userId } = await budgetUser();
    await addEntries(userId, [{ amount_cents: 120_000, occurred_at: '2026-10-14T09:00' }]);
    const calls = mockPushService(201);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runBudgetAlerts({ ...env, VAPID_SUBJECT: '' }, userId, '2026-10-14T09:00', NOW)).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(await logKeys(userId, 'budget')).toEqual([]);

    expect(await runBudgetAlerts(env, userId, '2026-10-14T09:00', NOW)).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('reads "this month" in the zone of the most recently seen device', async () => {
    const userId = await seedUser({ budget_cents: 200_000 });
    const zurich = await makeSubscriber(endpoint('zurich'));
    const newYork = await makeSubscriber(endpoint('new-york'));
    await addSubscription(userId, zurich, { tz: 'Europe/Zurich', lastSeenAt: 2_000 });
    const nyId = await addSubscription(userId, newYork, { tz: 'America/New_York', lastSeenAt: 1_000 });
    await addEntries(userId, [{ amount_cents: 150_000, occurred_at: '2026-10-20T12:00' }]);
    const calls = mockPushService(201);
    const halloweenNight = new Date('2026-10-31T23:30:00Z'); // Zurich: 1 Nov 00:30 · New York: 31 Oct 19:30

    // A message the New York device accepted does not make it the one in use.
    const [nyRow] = (await loadSubscriptions(env, userId)).filter((s) => s.id === nyId);
    expect((await sendToSubscriptions(env, nyRow ? [nyRow] : [], (lang) => ({ kind: 'test', title: 'T', body: 'B', url: '/', tag: 'test', lang }))).sent).toBe(1);
    expect(await subscriptionRow(nyId)).toMatchObject({ last_seen_at: 1_000 });
    calls.length = 0;

    expect(await runBudgetAlerts(env, userId, '2026-10-31T19:00', halloweenNight)).toBe(0);
    expect(calls).toHaveLength(0);

    await env.DB.prepare('UPDATE push_subscriptions SET last_seen_at = 3000 WHERE id = ?').bind(nyId).run();
    expect(await runBudgetAlerts(env, userId, '2026-10-31T19:00', halloweenNight)).toBe(2); // every device is told
    expect((await payloadsFor(calls, newYork))[0]?.body).toBe(`1${NNBSP}500.00 of 2${NNBSP}000 CHF · last day of the month`);
    expect(await logKeys(userId, 'budget')).toEqual(['2026-10:50']);
  });

  it('works through the hook the entries routes call, with the real clock', async () => {
    const { userId, sub } = await budgetUser();
    const today = zonedParts(new Date(), 'Europe/Zurich').day;
    const occurredAt = `${today}T08:00`;
    await addEntries(userId, [{ amount_cents: 110_000, occurred_at: occurredAt }]);
    const calls = mockPushService(201);

    await expect(maybeSendBudgetAlerts(env, userId, occurredAt)).resolves.toBeUndefined();
    expect((await payloadsFor(calls, sub)).map((p) => p.title)).toEqual(['Halfway through your budget']);
    expect(await logKeys(userId, 'budget')).toEqual([`${today.slice(0, 7)}:50`]);
  });

  it('never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenDb = {
      prepare: () => {
        throw new Error('D1 is down');
      },
    } as unknown as D1Database;
    await expect(maybeSendBudgetAlerts({ ...env, DB: brokenDb }, 'someone', '2026-10-14T09:00')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Budget alert failed', expect.any(Error));
  });
});
