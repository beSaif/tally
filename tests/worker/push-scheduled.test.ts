import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runScheduled } from '../../src/worker/push/scheduled';
import {
  addCategory,
  addEntries,
  addSubscription,
  logKeys,
  makeSubscriber,
  mockPushService,
  payloadsFor,
  resetDb,
  seedUser,
  setSettings,
  subscriptionRow,
} from './push-helpers';

const NNBSP = ' ';
// Europe/Zurich is on summer time (UTC+2) for all of these.
const MON_2037_LOCAL = new Date('2026-10-05T18:37:00Z'); // Monday 5 Oct, 20:37 → slot 20:30
const MON_0905_LOCAL = new Date('2026-10-05T07:05:00Z'); // Monday 5 Oct, 09:05 → slot 09:00
const THU_1ST_0900_LOCAL = new Date('2026-10-01T07:00:00Z'); // Thursday 1 Oct, 09:00

let n = 0;
const endpoint = (label: string) => `https://push.example/sub/${label}-${++n}`;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function reminderUser(settings: Parameters<typeof seedUser>[0] = {}) {
  const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30', ...settings });
  const sub = await makeSubscriber(endpoint('reminder'));
  const subId = await addSubscription(userId, sub, { tz: 'Europe/Zurich', lang: 'en' });
  return { userId, sub, subId };
}

describe('daily reminder', () => {
  it('goes out in the local slot of the reminder time, once per day', async () => {
    const { userId, sub } = await reminderUser();
    const calls = mockPushService(201);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('TTL')).toBe('3600');
    expect(calls[0]?.headers.get('Urgency')).toBe('normal');
    expect(await payloadsFor(calls, sub)).toEqual([
      {
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
      },
    ]);
    expect(await logKeys(userId, 'reminder')).toEqual(['2026-10-05']);

    await runScheduled(env, MON_2037_LOCAL);
    await runScheduled(env, new Date('2026-10-05T18:44:00Z'));
    expect(calls).toHaveLength(1);
  });

  it('stays quiet outside that slot', async () => {
    const { userId } = await reminderUser();
    const calls = mockPushService(201);
    for (const at of ['2026-10-05T18:00:00Z', '2026-10-05T18:29:00Z', '2026-10-05T18:45:00Z', '2026-10-05T20:30:00Z']) {
      await runScheduled(env, new Date(at));
    }
    expect(calls).toHaveLength(0);
    expect(await logKeys(userId, 'reminder')).toEqual([]);
  });

  it('is not sent when the user turned it off', async () => {
    await reminderUser({ notif_reminder: 0 });
    const calls = mockPushService(201);
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls).toHaveLength(0);
  });

  it('respects "only if nothing was logged" for the local day', async () => {
    const busy = await reminderUser();
    const quiet = await reminderUser();
    await addEntries(busy.userId, [{ amount_cents: 450, occurred_at: '2026-10-05T12:10' }]);
    await addEntries(quiet.userId, [
      { amount_cents: 450, occurred_at: '2026-10-04T23:59' },
      { amount_cents: 450, occurred_at: '2026-10-06T00:00' },
    ]);
    const calls = mockPushService(201);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url)).toEqual([quiet.sub.endpoint]);
    expect(await logKeys(busy.userId, 'reminder')).toEqual([]);

    // With the option off, a day with entries still gets its reminder.
    await setSettings(busy.userId, { notif_reminder_only_if_empty: 0 });
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url)).toEqual([quiet.sub.endpoint, busy.sub.endpoint]);
  });

  it('respects "skip today"', async () => {
    const skipped = await reminderUser();
    const skippedYesterday = await reminderUser();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO reminder_skips (user_id, day) VALUES (?, ?)').bind(skipped.userId, '2026-10-05'),
      env.DB.prepare('INSERT INTO reminder_skips (user_id, day) VALUES (?, ?)').bind(skippedYesterday.userId, '2026-10-04'),
    ]);
    const calls = mockPushService(201);
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url)).toEqual([skippedYesterday.sub.endpoint]);
    expect(await logKeys(skipped.userId, 'reminder')).toEqual([]);
  });

  it('reaches only the devices whose zone is due, each in its own language', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const zurichFr = await makeSubscriber(endpoint('zurich-fr'));
    const zurichEn = await makeSubscriber(endpoint('zurich-en'));
    const newYork = await makeSubscriber(endpoint('new-york'));
    await addSubscription(userId, zurichFr, { tz: 'Europe/Zurich', lang: 'fr' });
    await addSubscription(userId, zurichEn, { tz: 'Europe/Zurich', lang: 'en' });
    await addSubscription(userId, newYork, { tz: 'America/New_York', lang: 'en' }); // 14:37 there
    const calls = mockPushService(201);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url).sort()).toEqual([zurichEn.endpoint, zurichFr.endpoint].sort());
    expect(await payloadsFor(calls, zurichFr)).toEqual([
      {
        kind: 'reminder',
        title: `Des dépenses aujourd’hui${NNBSP}?`,
        body: 'Une phrase suffit.',
        url: '/?compose=1',
        tag: 'reminder',
        lang: 'fr',
        day: '2026-10-05',
        actions: [
          { action: 'log', title: 'Noter' },
          { action: 'skip', title: 'Pas aujourd’hui' },
        ],
      },
    ]);
    expect((await payloadsFor(calls, zurichEn))[0]?.title).toBe('Anything spent today?');
  });

  it('reaches devices in differently named zones with the same local time together', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const zurich = await makeSubscriber(endpoint('zurich'));
    const berlin = await makeSubscriber(endpoint('berlin'));
    await addSubscription(userId, zurich, { tz: 'Europe/Zurich' });
    await addSubscription(userId, berlin, { tz: 'Europe/Berlin' });
    const calls = mockPushService(201);
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url).sort()).toEqual([berlin.endpoint, zurich.endpoint].sort());
    expect(await logKeys(userId, 'reminder')).toEqual(['2026-10-05']);
  });

  it('falls back to UTC for a zone the runtime does not know', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '18:30' });
    const sub = await makeSubscriber(endpoint('nowhere'));
    await addSubscription(userId, sub, { tz: 'Mars/Olympus_Mons' });
    const calls = mockPushService(201);
    await runScheduled(env, MON_2037_LOCAL); // 18:37 UTC
    expect(calls.map((c) => c.url)).toEqual([sub.endpoint]);
  });
});

describe('weekly summary', () => {
  async function weeklyUser(settings: Parameters<typeof seedUser>[0] = {}) {
    const userId = await seedUser(settings);
    const groceries = await addCategory(userId, 'Groceries');
    const dining = await addCategory(userId, 'Dining');
    const transport = await addCategory(userId, 'Transport');
    // Last ISO week is Mon 28 Sep – Sun 4 Oct 2026: 256.90 in total, Groceries 105.30 (41%).
    await addEntries(userId, [
      { amount_cents: 6000, occurred_at: '2026-09-28T00:00', category_id: groceries },
      { amount_cents: 4530, occurred_at: '2026-10-04T23:59', category_id: groceries },
      { amount_cents: 8000, occurred_at: '2026-10-01T12:30', category_id: dining },
      { amount_cents: 7160, occurred_at: '2026-09-30T07:45', category_id: transport },
      // This week: not part of the summary.
      { amount_cents: 99_900, occurred_at: '2026-10-05T08:00', category_id: dining },
    ]);
    const en = await makeSubscriber(endpoint('weekly-en'));
    const fr = await makeSubscriber(endpoint('weekly-fr'));
    await addSubscription(userId, en, { tz: 'Europe/Zurich', lang: 'en' });
    await addSubscription(userId, fr, { tz: 'Europe/Zurich', lang: 'fr' });
    return { userId, en, fr };
  }

  it('goes out on Monday at 09:00 local with last week’s total and leader', async () => {
    const { userId, en, fr } = await weeklyUser();
    const calls = mockPushService(201);

    await runScheduled(env, MON_0905_LOCAL);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get('TTL')).toBe('86400');
    expect(calls[0]?.headers.get('Urgency')).toBe('normal');
    expect(await payloadsFor(calls, en)).toEqual([
      { kind: 'weekly', title: 'Last week: 256.90 CHF', body: 'Groceries led at 41% · 4 entries', url: '/overview?p=week', tag: 'weekly', lang: 'en' },
    ]);
    expect(await payloadsFor(calls, fr)).toEqual([
      {
        kind: 'weekly',
        title: `Semaine passée${NNBSP}: 256.90 CHF`,
        body: `Groceries en tête avec 41${NNBSP}% · 4 dépenses`,
        url: '/overview?p=week',
        tag: 'weekly',
        lang: 'fr',
      },
    ]);
    expect(await logKeys(userId, 'weekly')).toEqual(['2026-W40']);

    await runScheduled(env, MON_0905_LOCAL);
    expect(calls).toHaveLength(2);
  });

  it('compares with the week before when that week had spending', async () => {
    const { userId, en } = await weeklyUser();
    await addEntries(userId, [{ amount_cents: 23_790, occurred_at: '2026-09-27T20:00' }]); // Sunday of the week before
    const calls = mockPushService(201);
    await runScheduled(env, MON_0905_LOCAL);
    expect((await payloadsFor(calls, en))[0]).toMatchObject({ title: 'Last week: 256.90 CHF', body: 'Groceries led at 41% · +8% vs the week before' });
  });

  it('is skipped for an empty week, outside Monday 09:00, or when turned off', async () => {
    const empty = await seedUser();
    await addEntries(empty, [
      { amount_cents: 1000, occurred_at: '2026-09-27T23:59' },
      { amount_cents: 1000, occurred_at: '2026-10-05T00:00' },
    ]);
    await addSubscription(empty, await makeSubscriber(endpoint('empty')), { tz: 'Europe/Zurich' });
    const off = await weeklyUser({ notif_weekly: 0 });
    const calls = mockPushService(201);

    await runScheduled(env, MON_0905_LOCAL);
    expect(calls).toHaveLength(0);
    expect(await logKeys(empty, 'weekly')).toEqual([]);
    expect(await logKeys(off.userId, 'weekly')).toEqual([]);

    await setSettings(off.userId, { notif_weekly: 1 });
    await runScheduled(env, new Date('2026-10-05T08:05:00Z')); // Monday 10:05
    await runScheduled(env, new Date('2026-10-06T07:05:00Z')); // Tuesday 09:05
    expect(calls).toHaveLength(0);
  });
});

describe('monthly report', () => {
  async function monthlyUser(settings: Parameters<typeof seedUser>[0] = {}) {
    const userId = await seedUser(settings);
    const groceries = await addCategory(userId, 'Groceries');
    const dining = await addCategory(userId, 'Dining');
    const transport = await addCategory(userId, 'Transport');
    const home = await addCategory(userId, 'Home');
    // September 2026: 1 284.60 in 5 entries, Groceries leads with 412.30.
    await addEntries(userId, [
      { amount_cents: 20_000, occurred_at: '2026-09-01T00:00', category_id: groceries },
      { amount_cents: 21_230, occurred_at: '2026-09-30T23:59', category_id: groceries },
      { amount_cents: 30_000, occurred_at: '2026-09-12T19:30', category_id: dining },
      { amount_cents: 25_000, occurred_at: '2026-09-15T08:10', category_id: transport },
      { amount_cents: 32_230, occurred_at: '2026-09-20T10:00', category_id: home },
      // Other months: not part of the report.
      { amount_cents: 50_000, occurred_at: '2026-08-31T23:00', category_id: home },
      { amount_cents: 50_000, occurred_at: '2026-10-01T08:00', category_id: home },
    ]);
    return { userId };
  }

  it('goes out on the 1st at 09:00 local with last month against the budget', async () => {
    const { userId } = await monthlyUser({ budget_cents: 200_000 });
    const sub = await makeSubscriber(endpoint('monthly'));
    await addSubscription(userId, sub, { tz: 'Europe/Zurich', lang: 'en' });
    const calls = mockPushService(201);

    await runScheduled(env, THU_1ST_0900_LOCAL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('TTL')).toBe('86400');
    expect(await payloadsFor(calls, sub)).toEqual([
      { kind: 'monthly', title: `September: 1${NNBSP}284.60 CHF`, body: '64% of your budget · Groceries 412.30 led', url: '/overview?p=month', tag: 'monthly', lang: 'en' },
    ]);
    expect(await logKeys(userId, 'monthly')).toEqual(['2026-09']);

    await runScheduled(env, THU_1ST_0900_LOCAL);
    expect(calls).toHaveLength(1);
  });

  it('counts entries instead when there is no budget, and speaks French', async () => {
    const { userId } = await monthlyUser({ budget_cents: null });
    const en = await makeSubscriber(endpoint('monthly-en'));
    const fr = await makeSubscriber(endpoint('monthly-fr'));
    await addSubscription(userId, en, { tz: 'Europe/Zurich', lang: 'en' });
    await addSubscription(userId, fr, { tz: 'Europe/Zurich', lang: 'fr' });
    const calls = mockPushService(201);

    await runScheduled(env, THU_1ST_0900_LOCAL);
    expect((await payloadsFor(calls, en))[0]).toMatchObject({ title: `September: 1${NNBSP}284.60 CHF`, body: 'Groceries 412.30 led · 5 entries' });
    expect((await payloadsFor(calls, fr))[0]).toMatchObject({
      title: `Septembre${NNBSP}: 1${NNBSP}284.60 CHF`,
      body: 'Groceries en tête avec 412.30 · 5 dépenses',
      lang: 'fr',
    });
  });

  it('is skipped for an empty month, outside the 1st at 09:00, or when turned off', async () => {
    const empty = await seedUser();
    await addEntries(empty, [{ amount_cents: 1000, occurred_at: '2026-10-01T00:00' }]);
    await addSubscription(empty, await makeSubscriber(endpoint('monthly-empty')), { tz: 'Europe/Zurich' });
    const off = await monthlyUser({ notif_monthly: 0 });
    await addSubscription(off.userId, await makeSubscriber(endpoint('monthly-off')), { tz: 'Europe/Zurich' });
    const calls = mockPushService(201);

    await runScheduled(env, THU_1ST_0900_LOCAL);
    expect(calls).toHaveLength(0);
    expect(await logKeys(empty, 'monthly')).toEqual([]);

    await setSettings(off.userId, { notif_monthly: 1 });
    await runScheduled(env, new Date('2026-10-01T06:45:00Z')); // 08:45
    await runScheduled(env, new Date('2026-10-02T07:00:00Z')); // the 2nd
    expect(calls).toHaveLength(0);
    await runScheduled(env, THU_1ST_0900_LOCAL);
    expect(calls).toHaveLength(1);
  });
});

describe('delivery bookkeeping', () => {
  it('deletes a subscription the push service reports gone (410)', async () => {
    const { userId, subId } = await reminderUser();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = mockPushService(410);
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls).toHaveLength(1);
    expect(await subscriptionRow(subId)).toBeNull();
    // It was attempted, so it stays logged and is not retried.
    expect(await logKeys(userId, 'reminder')).toEqual(['2026-10-05']);
  });

  it('counts other failures and drops a device after five in a row; a success resets the count', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const flaky = await makeSubscriber(endpoint('flaky'));
    const healthy = await makeSubscriber(endpoint('healthy'));
    const flakyId = await addSubscription(userId, flaky, { tz: 'Europe/Zurich', failures: 3 });
    const healthyId = await addSubscription(userId, healthy, { tz: 'Europe/Zurich', failures: 4, lastSeenAt: 1 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPushService((url) => (url === flaky.endpoint ? 503 : 201));

    await runScheduled(env, MON_2037_LOCAL);
    expect(await subscriptionRow(flakyId)).toMatchObject({ failures: 4 });
    const healthyRow = await subscriptionRow(healthyId);
    expect(healthyRow?.failures).toBe(0);
    expect(healthyRow?.last_seen_at).toBeGreaterThan(1);

    await runScheduled(env, new Date('2026-10-06T18:37:00Z')); // next day's reminder
    expect(await subscriptionRow(flakyId)).toBeNull();
    expect(await subscriptionRow(healthyId)).not.toBeNull();
  });

  it('isolates a broken device and keeps serving everyone else', async () => {
    const broken = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    // A point that is not on the curve: encryption fails for this device only.
    const notOnCurve = 'B' + 'A'.repeat(86);
    const brokenId = await addSubscription(broken, { endpoint: endpoint('broken'), p256dh: notOnCurve, auth: 'AAAAAAAAAAAAAAAAAAAAAA' }, { tz: 'Europe/Zurich' });
    const ok = await reminderUser();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = mockPushService(201);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url)).toEqual([ok.sub.endpoint]);
    expect(await subscriptionRow(brokenId)).toMatchObject({ failures: 1 });
  });

  it('never throws, and sends nothing (nor logs) without VAPID keys', async () => {
    const { userId } = await reminderUser();
    const calls = mockPushService(201);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runScheduled({ ...env, VAPID_PRIVATE_KEY: '' }, MON_2037_LOCAL)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(calls).toHaveLength(0);
    expect(await logKeys(userId, 'reminder')).toEqual([]);

    const brokenDb = {
      prepare: () => {
        throw new Error('D1 is down');
      },
    } as unknown as D1Database;
    await expect(runScheduled({ ...env, DB: brokenDb }, MON_2037_LOCAL)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not list subscribers'), expect.any(Error));
  });
});
