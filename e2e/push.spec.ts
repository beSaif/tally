/**
 * Web Push end to end (spec §8): the Worker encrypts for this device, the stand-in push service
 * receives it, and the real service worker shows it (delivered through the DevTools protocol, the
 * way DevTools' "Push" button does). Clicks are dispatched inside the worker. Also: the app shell
 * opens offline from the precache. Runs the full Chromium build: the headless shell has no
 * notification support.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { PushPayload } from '../src/shared/api';
import { fakePushState } from './support/fake-push';
import { designAccount, prepare } from './support/fixtures';
import { decryptDelivery, PushSink } from './support/push-sink';

test.use({ channel: 'chromium' });

const sink = new PushSink();
test.beforeAll(() => sink.start());
test.afterAll(() => sink.stop());

interface Shown {
  title: string;
  body: string;
  tag: string;
  data: unknown;
  icon: string;
  badge: string;
  lang: string;
  actions: Array<{ action: string; title: string }>;
}

async function allowNotifications(context: BrowserContext, origin: string): Promise<void> {
  await context.grantPermissions(['notifications'], { origin });
}

/** Hands a push message to the page's service worker, as a push service would. */
async function deliverPush(page: Page, payload: PushPayload): Promise<void> {
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  const cdp = await page.context().newCDPSession(page);
  const registrations: Array<{ registrationId: string; scopeURL: string }> = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: Array<{ registrationId: string; scopeURL: string; isDeleted: boolean }> }) =>
    registrations.push(...e.registrations.filter((r) => !r.isDeleted)),
  );
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => registrations.some((r) => r.scopeURL === scope)).toBe(true);
  const reg = registrations.find((r) => r.scopeURL === scope);
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(scope).origin, registrationId: reg?.registrationId ?? '', data: JSON.stringify(payload) });
  await cdp.detach();
}

async function shown(page: Page, tag: string): Promise<Shown[]> {
  return page.evaluate(async (t) => {
    const list = await (await navigator.serviceWorker.ready).getNotifications({ tag: t });
    return list.map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data as unknown,
      icon: n.icon,
      badge: n.badge,
      lang: n.lang,
      actions: [...((n as unknown as { actions?: Array<{ action: string; title: string }> }).actions ?? [])].map((a) => ({ action: a.action, title: a.title })),
    }));
  }, tag);
}

/** A click on the notification with this tag, dispatched inside the service worker. */
async function clickNotification(context: BrowserContext, tag: string, action: string): Promise<void> {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('no service worker');
  await worker.evaluate(
    async ([t, a]) => {
      const scope = self as unknown as ServiceWorkerGlobalScope;
      const [notification] = await scope.registration.getNotifications({ tag: t });
      if (!notification) throw new Error(`no notification tagged ${t}`);
      scope.dispatchEvent(new NotificationEvent('notificationclick', { notification, action: a }));
    },
    [tag, action] as const,
  );
}

async function enableOnThisDevice(page: Page): Promise<NonNullable<Awaited<ReturnType<typeof fakePushState>>['sub']>> {
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Notifications on this device' }).click();
  await expect(page.getByText('This device', { exact: true })).toBeVisible();
  const { sub } = await fakePushState(page);
  if (!sub) throw new Error('not subscribed');
  return sub;
}

test('a test notification is encrypted for this device and shown by the service worker', async ({ page, context, baseURL }) => {
  await allowNotifications(context, new URL(baseURL ?? '').origin);
  await prepare(page, { withKey: true, pushEndpoint: sink.endpointBase });
  await designAccount(page);
  const sub = await enableOnThisDevice(page);
  const subscriptions = (await (await page.request.get('/api/push/subscriptions')).json()) as { subscriptions: Array<{ endpoint: string; lang: string; tz: string }> };
  expect(subscriptions.subscriptions).toEqual([expect.objectContaining({ endpoint: sub.endpoint, lang: 'en', tz: 'Europe/Zurich' })]);

  // Every app start tells the server this device is alive (language, zone, user agent).
  const announced = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/push/subscribe'));
  await page.reload();
  expect((await announced).postDataJSON()).toMatchObject({
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    lang: 'en',
    tz: 'Europe/Zurich',
    user_agent: expect.stringContaining('Mozilla/5.0'),
  });
  await expect(page.getByText('This device', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Send a test notification' }).click();
  await expect(page.locator('.toast')).toHaveText('Sent to 1 device.');
  const [delivery] = sink.to(sub.endpoint);
  if (!delivery) throw new Error('nothing delivered');
  expect(delivery.headers.ttl).toBe('3600');
  const payload = decryptDelivery(delivery.body, sub);
  expect(payload).toEqual({ kind: 'test', title: 'Notifications are on', body: 'This is how Tally will nudge you.', url: '/settings', tag: 'test', lang: 'en' });

  await deliverPush(page, payload);
  await expect.poll(() => shown(page, 'test')).toHaveLength(1);
  const [notification] = await shown(page, 'test');
  expect(notification).toMatchObject({ title: 'Notifications are on', body: 'This is how Tally will nudge you.', lang: 'en', data: { url: '/settings', kind: 'test' } });
  expect(notification?.icon).toMatch(/\/icons\/icon-192\.png$/);
  expect(notification?.badge).toMatch(/\/icons\/badge-96\.png$/);

  // Clicking it brings the open window to the page it names, in-app.
  await page.goto('/');
  await clickNotification(context, 'test', '');
  await expect(page).toHaveURL(/\/settings$/);
  expect(await shown(page, 'test')).toHaveLength(0);
});

test('the daily reminder from the scheduler: Log now opens the composer, Skip today is recorded', async ({ page, context, baseURL }) => {
  await allowNotifications(context, new URL(baseURL ?? '').origin);
  await prepare(page, { withKey: true, pushEndpoint: sink.endpointBase });
  await designAccount(page);
  const sub = await enableOnThisDevice(page);

  // Due now: the reminder time is this 15-minute slot in the device's zone (real time, as the cron sees it).
  let reminder: PushPayload | undefined;
  for (let attempt = 0; attempt < 2 && !reminder; attempt++) {
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const [h, m] = now.split(':').map(Number);
    const slot = `${String(h).padStart(2, '0')}:${String(Math.floor((m ?? 0) / 15) * 15).padStart(2, '0')}`;
    const put = await page.request.put('/api/settings', { data: { notifications: { reminder: true, reminder_time: slot, reminder_only_if_empty: false } } });
    expect(put.ok()).toBe(true);
    expect((await page.request.get('/__scheduled?cron=*/15+*+*+*+*')).ok()).toBe(true);
    const found = sink.to(sub.endpoint).map((d) => decryptDelivery(d.body, sub)).find((p) => p.kind === 'reminder');
    if (found) reminder = found;
  }
  if (!reminder) throw new Error('no reminder delivered');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
  expect(reminder).toMatchObject({ url: '/?compose=1', tag: 'reminder', lang: 'en', day: today });
  expect(reminder.actions).toEqual([
    { action: 'log', title: expect.any(String) },
    { action: 'skip', title: expect.any(String) },
  ]);

  await deliverPush(page, reminder);
  await expect.poll(() => shown(page, 'reminder')).toHaveLength(1);
  const [notification] = await shown(page, 'reminder');
  expect(notification?.actions.map((a) => a.action)).toEqual(['log', 'skip']);
  expect(notification?.data).toEqual({ url: '/?compose=1', kind: 'reminder', day: today });

  // "Log now": the open window goes home with the composer focused.
  await page.goto('/overview');
  await clickNotification(context, 'reminder', 'log');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('Describe an expense')).toBeFocused();

  // "Skip today": the worker records the skip for that day and opens nothing.
  await deliverPush(page, reminder);
  await expect.poll(() => shown(page, 'reminder')).toHaveLength(1);
  // The worker's own requests are not reported to the page: watch its fetch instead.
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('no service worker');
  await worker.evaluate(() => {
    const scope = self as unknown as { fetch: typeof fetch; __calls: Array<{ url: string; body: string; status: number }> };
    const real = scope.fetch.bind(self);
    scope.__calls = [];
    scope.fetch = async (input, init) => {
      const res = await real(input, init);
      scope.__calls.push({ url: String(input), body: String(init?.body ?? ''), status: res.status });
      return res;
    };
  });
  await clickNotification(context, 'reminder', 'skip');
  await expect
    .poll(() => worker.evaluate(() => (self as unknown as { __calls: Array<{ url: string; body: string; status: number }> }).__calls))
    .toEqual([{ url: '/api/push/skip', body: JSON.stringify({ day: today }), status: 204 }]);
  expect(await shown(page, 'reminder')).toHaveLength(0);
  await expect(page).toHaveURL(/\/$/);
});

test('a weekly summary click opens the week overview', async ({ page, context, baseURL }) => {
  await allowNotifications(context, new URL(baseURL ?? '').origin);
  await prepare(page, { withKey: true, pushEndpoint: sink.endpointBase });
  await designAccount(page);
  await enableOnThisDevice(page);
  await page.goto('/');
  await deliverPush(page, { kind: 'weekly', title: 'Last week: 256.90 CHF', body: 'Groceries led at 41% · 12 entries', url: '/overview?p=week', tag: 'weekly', lang: 'en' });
  await expect.poll(() => shown(page, 'weekly')).toHaveLength(1);
  await clickNotification(context, 'weekly', '');
  await expect(page).toHaveURL(/\/overview\?p=week$/);
  await expect(page.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true');
});

test('offline: the shell opens from the service worker and API calls say so', async ({ page, context }) => {
  await prepare(page, { withKey: true });
  await designAccount(page);
  await page.goto('/');
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.toast')).toHaveText("You're offline.");
  await expect(page.getByText('Could not load your entries.')).toBeVisible();
  await expect(page.getByLabel('Describe an expense')).toBeVisible();

  await context.setOffline(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');
});
