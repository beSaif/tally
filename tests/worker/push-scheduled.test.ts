import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { meteredDb, QueryMeter } from '../../src/worker/lib/d1-meter';
import { QUERY_BUDGET, runScheduled } from '../../src/worker/push/scheduled';
import { fromB64url } from '../../src/worker/push/webpush';
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

const NNBSP = '\u202f';
// Europe/Zurich is on summer time (UTC+2) and New York on EDT (UTC−4) for all of these.
const MON_2037_LOCAL = new Date('2026-10-05T18:37:00Z'); // Monday 5 Oct, 20:37 in Zurich
const MON_0905_LOCAL = new Date('2026-10-05T07:05:00Z'); // Monday 5 Oct, 09:05 in Zurich
const THU_1ST_0900_LOCAL = new Date('2026-10-01T07:00:00Z'); // Thursday 1 Oct, 09:00 in Zurich
const ZURICH_KEY = (period: string) => `${period}@Europe/Zurich`;

let n = 0;
const endpoint = (label: string, origin = 'https://push.example') => `${origin}/sub/${label}-${++n}`;

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
  it('goes out within the hour from the reminder time, once per day and zone', async () => {
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
    expect(await logKeys(userId, 'reminder')).toEqual([ZURICH_KEY('2026-10-05')]);

    // The later runs of the hour find it sent.
    for (const at of ['2026-10-05T18:37:00Z', '2026-10-05T18:45:00Z', '2026-10-05T19:15:00Z', '2026-10-05T19:29:00Z']) {
      await runScheduled(env, new Date(at));
    }
    expect(calls).toHaveLength(1);
  });

  it('stays quiet before the reminder time and after its hour', async () => {
    const { userId } = await reminderUser();
    const calls = mockPushService(201);
    for (const at of ['2026-10-05T18:00:00Z', '2026-10-05T18:29:00Z', '2026-10-05T19:30:00Z', '2026-10-05T20:30:00Z']) {
      await runScheduled(env, new Date(at)); // 20:00, 20:29, 21:30, 22:30 in Zurich
    }
    expect(calls).toHaveLength(0);
    expect(await logKeys(userId, 'reminder')).toEqual([]);
  });

  it('goes out at the first run at or after a time between the quarter hours, never before', async () => {
    const { userId } = await reminderUser({ notif_reminder_time: '20:44' });
    const calls = mockPushService(201);
    await runScheduled(env, new Date('2026-10-05T18:30:00Z')); // 20:30: too early
    expect(calls).toHaveLength(0);
    await runScheduled(env, new Date('2026-10-05T18:45:00Z')); // 20:45
    expect(calls).toHaveLength(1);
    expect(await logKeys(userId, 'reminder')).toEqual([ZURICH_KEY('2026-10-05')]);
  });

  it('runs past midnight for a late reminder, about the evening’s day', async () => {
    const { userId, sub } = await reminderUser({ notif_reminder_time: '23:50' });
    await addEntries(userId, [{ amount_cents: 450, occurred_at: '2026-10-06T00:00' }]); // the next day
    const calls = mockPushService(201);

    await runScheduled(env, new Date('2026-10-05T21:45:00Z')); // 23:45
    expect(calls).toHaveLength(0);
    await runScheduled(env, new Date('2026-10-05T22:00:00Z')); // 00:00 on the 6th
    expect((await payloadsFor(calls, sub)).map((p) => p.day)).toEqual(['2026-10-05']);
    await runScheduled(env, new Date('2026-10-05T22:45:00Z')); // 00:45, still in the hour
    expect(calls).toHaveLength(1);
    expect(await logKeys(userId, 'reminder')).toEqual([ZURICH_KEY('2026-10-05')]);
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

  it('reaches devices in another zone in their own evening, not only the first zone’s', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const zurich = await makeSubscriber(endpoint('zurich'));
    const newYork = await makeSubscriber(endpoint('new-york'));
    await addSubscription(userId, zurich, { tz: 'Europe/Zurich' });
    await addSubscription(userId, newYork, { tz: 'America/New_York' });
    const calls = mockPushService(201);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url)).toEqual([zurich.endpoint]);
    await runScheduled(env, new Date('2026-10-06T00:37:00Z')); // 20:37 on the 5th in New York
    expect(calls.map((c) => c.url)).toEqual([zurich.endpoint, newYork.endpoint]);
    expect((await payloadsFor(calls, newYork))[0]?.day).toBe('2026-10-05');
    expect(await logKeys(userId, 'reminder')).toEqual(['2026-10-05@America/New_York', ZURICH_KEY('2026-10-05')]);
  });

  it('reaches devices in differently named zones with the same local time, one claim per zone', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const zurich = await makeSubscriber(endpoint('zurich'));
    const berlin = await makeSubscriber(endpoint('berlin'));
    await addSubscription(userId, zurich, { tz: 'Europe/Zurich' });
    await addSubscription(userId, berlin, { tz: 'Europe/Berlin' });
    const calls = mockPushService(201);
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls.map((c) => c.url).sort()).toEqual([berlin.endpoint, zurich.endpoint].sort());
    expect(await logKeys(userId, 'reminder')).toEqual(['2026-10-05@Europe/Berlin', ZURICH_KEY('2026-10-05')]);
  });

  it('falls back to UTC for a zone the runtime does not know', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '18:30' });
    const sub = await makeSubscriber(endpoint('nowhere'));
    await addSubscription(userId, sub, { tz: 'Mars/Olympus_Mons' });
    const calls = mockPushService(201);
    await runScheduled(env, MON_2037_LOCAL); // 18:37 UTC
    expect(calls.map((c) => c.url)).toEqual([sub.endpoint]);
    expect(await logKeys(userId, 'reminder')).toEqual(['2026-10-05@UTC']);
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
    expect(await logKeys(userId, 'weekly')).toEqual([ZURICH_KEY('2026-W40')]);

    await runScheduled(env, MON_0905_LOCAL);
    expect(calls).toHaveLength(2);
  });

  it('stays due until 09:59, and reaches another zone on its own Monday morning', async () => {
    const { userId, en } = await weeklyUser();
    const newYork = await makeSubscriber(endpoint('weekly-new-york'));
    await addSubscription(userId, newYork, { tz: 'America/New_York', lang: 'en' });
    const calls = mockPushService(201);

    await runScheduled(env, new Date('2026-10-05T06:59:00Z')); // 08:59 in Zurich
    expect(calls).toHaveLength(0);
    await runScheduled(env, new Date('2026-10-05T07:59:00Z')); // 09:59 in Zurich, 03:59 in New York
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).not.toContain(newYork.endpoint);
    await runScheduled(env, new Date('2026-10-05T13:45:00Z')); // 09:45 in New York
    expect(calls.map((c) => c.url)).toContain(newYork.endpoint);
    expect(await payloadsFor(calls, newYork)).toEqual(await payloadsFor(calls, en));
    expect(await logKeys(userId, 'weekly')).toEqual(['2026-W40@America/New_York', ZURICH_KEY('2026-W40')]);
  });

  it('never names a category of another user', async () => {
    const stranger = await seedUser();
    const secret = await addCategory(stranger, 'Secret project');
    const userId = await seedUser();
    // Not possible through the API (OWN_CATEGORY_SQL), so seeded directly.
    await addEntries(userId, [{ amount_cents: 5000, occurred_at: '2026-09-30T12:00', category_id: secret }]);
    const sub = await makeSubscriber(endpoint('foreign-category'));
    await addSubscription(userId, sub, { tz: 'Europe/Zurich' });
    const calls = mockPushService(201);

    await runScheduled(env, MON_0905_LOCAL);
    expect(await payloadsFor(calls, sub)).toMatchObject([{ kind: 'weekly', title: 'Last week: 50.00 CHF', body: 'Other led at 100% · 1 entry' }]);
  });

  it('compares with the week before when that week had spending', async () => {
    const { userId, en } = await weeklyUser();
    await addEntries(userId, [{ amount_cents: 23_790, occurred_at: '2026-09-27T20:00' }]); // Sunday of the week before
    const calls = mockPushService(201);
    await runScheduled(env, MON_0905_LOCAL);
    expect((await payloadsFor(calls, en))[0]).toMatchObject({ title: 'Last week: 256.90 CHF', body: 'Groceries led at 41% · +8% vs the week before' });
  });

  it('is skipped for an empty week, outside Monday 09:00–09:59, or when turned off', async () => {
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
    await runScheduled(env, new Date('2026-10-05T08:00:00Z')); // Monday 10:00
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
    expect(await logKeys(userId, 'monthly')).toEqual([ZURICH_KEY('2026-09')]);

    await runScheduled(env, THU_1ST_0900_LOCAL);
    await runScheduled(env, new Date('2026-10-01T07:45:00Z'));
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

  it('is skipped for an empty month, outside the 1st 09:00–09:59, or when turned off', async () => {
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
    await runScheduled(env, new Date('2026-10-01T08:00:00Z')); // 10:00
    await runScheduled(env, new Date('2026-10-02T07:00:00Z')); // the 2nd
    expect(calls).toHaveLength(0);
    await runScheduled(env, new Date('2026-10-01T07:59:00Z')); // 09:59
    expect(calls).toHaveLength(1);
  });
});

describe('delivery bookkeeping', () => {
  it('deletes a subscription the push service reports gone (410), and keeps the claim', async () => {
    const { userId, subId } = await reminderUser();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = mockPushService(410);
    await runScheduled(env, MON_2037_LOCAL);
    expect(calls).toHaveLength(1);
    expect(await subscriptionRow(subId)).toBeNull();
    // Every device is gone, so there is nothing to retry: it stays logged.
    expect(await logKeys(userId, 'reminder')).toEqual([ZURICH_KEY('2026-10-05')]);
  });

  it('gives the claim back when no device took it, so a later run in the hour retries', async () => {
    const { userId, sub, subId } = await reminderUser();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let status = 503;
    const calls = mockPushService(() => status);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls).toHaveLength(1);
    expect(await logKeys(userId, 'reminder')).toEqual([]);
    expect(await subscriptionRow(subId)).toMatchObject({ failures: 1 });

    status = 201;
    await runScheduled(env, new Date('2026-10-05T18:52:00Z'));
    expect(calls).toHaveLength(2);
    expect((await payloadsFor(calls, sub))[1]?.day).toBe('2026-10-05');
    expect(await logKeys(userId, 'reminder')).toEqual([ZURICH_KEY('2026-10-05')]);
    expect(await subscriptionRow(subId)).toMatchObject({ failures: 0 });
  });

  it('counts other failures and drops a device after five in a row; a success resets the count but not last_seen_at', async () => {
    const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const flaky = await makeSubscriber(endpoint('flaky'));
    const healthy = await makeSubscriber(endpoint('healthy'));
    const flakyId = await addSubscription(userId, flaky, { tz: 'Europe/Zurich', failures: 3 });
    const healthyId = await addSubscription(userId, healthy, { tz: 'Europe/Zurich', failures: 4, lastSeenAt: 1 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPushService((url) => (url === flaky.endpoint ? 503 : 201));

    await runScheduled(env, MON_2037_LOCAL);
    expect(await subscriptionRow(flakyId)).toMatchObject({ failures: 4 });
    // Accepted for delivery says nothing about the device being in use: only /subscribe moves last_seen_at.
    expect(await subscriptionRow(healthyId)).toMatchObject({ failures: 0, last_seen_at: 1 });
    // One device took it, so the day is done.
    expect(await logKeys(userId, 'reminder')).toEqual([ZURICH_KEY('2026-10-05')]);

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

  it('signs one VAPID token per push service for the whole run', async () => {
    const users = [await reminderUser(), await reminderUser()];
    const elsewhere = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
    const otherService = await makeSubscriber(endpoint('elsewhere', 'https://other.example'));
    await addSubscription(elsewhere, otherService, { tz: 'Europe/Zurich' });
    const calls = mockPushService(201);

    await runScheduled(env, MON_2037_LOCAL);
    expect(calls).toHaveLength(3);
    const authorization = (url: string) => calls.find((c) => c.url === url)?.headers.get('Authorization');
    const [first, second] = users.map((u) => authorization(u.sub.endpoint));
    expect(first).toMatch(/^vapid t=/);
    expect(second).toBe(first); // ECDSA signatures are randomised: equal means signed once
    const other = authorization(otherService.endpoint);
    expect(other).not.toBe(first);
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(other?.slice('vapid t='.length).split('.')[1] ?? ''))) as { aud: string };
    expect(claims.aud).toBe('https://other.example');
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

describe('query budget', () => {
  it('starts no new work past the budget, in user_id order, and the next run in the hour does the rest', async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => reminderUser()));
    users.sort((a, b) => (a.userId < b.userId ? -1 : 1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = mockPushService(201);

    const first = new QueryMeter();
    await runScheduled({ ...env, DB: meteredDb(env.DB, first) }, MON_2037_LOCAL);
    const served = calls.length;
    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(20);
    expect(first.used).toBeGreaterThanOrEqual(QUERY_BUDGET);
    expect(first.used).toBeLessThanOrEqual(50); // D1's per-invocation limit on the Free plan
    expect(calls.map((c) => c.url)).toEqual(users.slice(0, served).map((u) => u.sub.endpoint));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${20 - served} user(s) deferred`));

    // The next run skips what is done without a query per user, and finishes.
    warn.mockClear();
    const second = new QueryMeter();
    await runScheduled({ ...env, DB: meteredDb(env.DB, second) }, new Date('2026-10-05T18:45:00Z'));
    expect(warn).not.toHaveBeenCalled();
    expect(calls.map((c) => c.url).sort()).toEqual(users.map((u) => u.sub.endpoint).sort());
    expect(second.used).toBeLessThan(QUERY_BUDGET);
  });

  it('stays under D1’s limit when every device of every user fails', async () => {
    const users = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const userId = await seedUser({ notif_reminder: 1, notif_reminder_time: '20:30' });
        for (let i = 0; i < 4; i++) await addSubscription(userId, await makeSubscriber(endpoint('down')), { tz: 'Europe/Zurich' });
        return userId;
      }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPushService(503);

    const meter = new QueryMeter();
    await runScheduled({ ...env, DB: meteredDb(env.DB, meter) }, MON_2037_LOCAL);
    expect(meter.used).toBeLessThanOrEqual(50);
    // Nobody got anything, so nothing stays claimed: the next run tries again.
    for (const userId of users) expect(await logKeys(userId, 'reminder')).toEqual([]);
  });
});

describe('housekeeping', () => {
  it('prunes skips older than 60 days and log rows older than 90 days in every run', async () => {
    const userId = await seedUser();
    const DAY = 86_400_000;
    const now = MON_2037_LOCAL;
    await env.DB.batch([
      ...['2026-08-05', '2026-08-06', '2026-10-05'].map((day) => env.DB.prepare('INSERT INTO reminder_skips (user_id, day) VALUES (?, ?)').bind(userId, day)),
      ...[91, 90, 1].map((days) =>
        env.DB.prepare('INSERT INTO notification_log (user_id, kind, period_key, sent_at) VALUES (?, ?, ?, ?)').bind(userId, 'budget', `${days} days`, now.getTime() - days * DAY),
      ),
    ]);

    await runScheduled(env, now); // nobody has a device: nothing is due, the pruning still runs
    const skips = await env.DB.prepare('SELECT day FROM reminder_skips WHERE user_id = ? ORDER BY day').bind(userId).all<{ day: string }>();
    expect(skips.results.map((r) => r.day)).toEqual(['2026-08-06', '2026-10-05']);
    expect(await logKeys(userId, 'budget')).toEqual(['1 days', '90 days']);
  });
});
