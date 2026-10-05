/**
 * The end-to-end flow of docs/SPEC.md §10 against the real Worker API, with Gemini mocked and a
 * stand-in push service: sign up → setup → text log → batch → edit → delete + undo → overview →
 * CSV export → ask → notifications (on + test) → log out → log in → the data is still there.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Request } from '@playwright/test';
import { DEFAULT_MODEL } from '../src/shared/constants';
import type { Settings } from '../src/shared/api';
import { decryptDelivery, PushSink } from './support/push-sink';
import { fakePushState } from './support/fake-push';
import { listEntries, PASSWORD, prepare, shot, TEST_KEY, uniqueEmail } from './support/fixtures';
import { BATCH_TEXT } from './support/mock-gemini';

const sink = new PushSink();
test.beforeAll(() => sink.start());
test.afterAll(() => sink.stop());

const composer = (page: Page) => page.getByLabel('Describe an expense');
const row = (page: Page, text: string) => page.locator('.entries li', { hasText: text });

async function logText(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test('sign up, log, edit, delete, overview, export, ask, notifications, log out and back in', async ({ page }) => {
  test.setTimeout(150_000);
  const { gemini } = await prepare(page, { pushEndpoint: sink.endpointBase });
  // The Gemini key must never travel to our API.
  const apiRequests: Request[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) apiRequests.push(r);
  });
  const email = uniqueEmail('flow');

  // ---- sign up
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'New here? Create an account' }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole('heading', { name: /Create your/ })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // ---- setup, step 1: the key is checked live (rejected, then pasted and accepted)
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText('Step 01 / 02')).toBeVisible();
  const cont = page.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await page.getByLabel('Google AI Studio API key').fill('AIza-wrong-key-123456789');
  await expect(page.getByRole('status').filter({ hasText: 'Key rejected by Google' })).toBeVisible();
  await expect(cont).toBeDisabled();
  await page.evaluate((key) => navigator.clipboard.writeText(key), TEST_KEY);
  await page.getByRole('button', { name: 'Paste' }).click();
  await expect(page.getByText(`Key works · ${DEFAULT_MODEL}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google AI Studio API key' })).toHaveText('AIza••••••••••••••Qx4');
  await cont.click();

  // ---- setup, step 2: defaults
  await expect(page.getByText('Step 02 / 02')).toBeVisible();
  await expect(page.getByLabel('Currency')).toHaveValue('CHF');
  await page.getByLabel('Budget').fill('2000');
  await page.getByLabel('Budget').blur();
  await expect(page.getByLabel('Budget')).toHaveValue('2\u202f000.00');
  await page.getByRole('button', { name: 'Health' }).click();
  await expect(page.getByRole('button', { name: 'Health' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '+ Add' }).click();
  await page.getByLabel('New category').fill('Kids');
  await page.getByLabel('New category').press('Enter');
  await expect(page.getByRole('button', { name: 'Kids' })).toBeVisible();
  await page.getByRole('button', { name: 'Start logging' }).click();

  // ---- home, empty
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Nothing logged yet. Type a line or tap the mic.')).toBeVisible();
  await expect(page.locator('.hero-num')).toHaveText('0.00');
  await expect(page.getByText('0% of 2 000')).toBeVisible();
  const me = (await (await page.request.get('/api/auth/me')).json()) as { settings: Settings; categories: Array<{ name: string }> };
  expect(me.settings).toMatchObject({ currency: 'CHF', budget_cents: 200_000, setup_complete: true });
  expect(me.categories.map((c) => c.name)).toEqual(['Groceries', 'Dining', 'Transport', 'Home', 'Fun', 'Shopping', 'Bills', 'Kids']);
  expect(await page.evaluate(() => localStorage.getItem('tally.gemini.key'))).toBe(TEST_KEY);

  // ---- text log, one entry
  await logText(page, 'Coffee 4.50');
  const sheet = page.getByRole('dialog', { name: 'New expense' });
  await expect(sheet.getByText('Gemini parsed')).toBeVisible();
  await expect(sheet.locator('.kv .amount')).toHaveText('4.50 CHF');
  await expect(composer(page)).toHaveValue('');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(row(page, 'Coffee')).toHaveClass(/fresh/);
  await expect(row(page, 'Coffee')).toContainText('Dining');
  await expect(row(page, 'Coffee')).toContainText('4.50');
  await expect(page.locator('.hero-num')).toHaveText('4.50');
  await expect(page.locator('.daygrp').first()).toContainText('Today');

  // ---- batch: three entries, one unchecked
  await logText(page, BATCH_TEXT);
  await expect(sheet.getByText('3 entries found')).toBeVisible();
  await expect(sheet.locator('.total')).toHaveText('50.20 CHF');
  await sheet.getByRole('checkbox', { name: 'Include Coffee' }).click();
  await expect(sheet.getByRole('checkbox', { name: 'Include Coffee' })).toHaveAttribute('aria-checked', 'false');
  await expect(sheet.locator('.total')).toHaveText('46.20 CHF');
  await sheet.getByRole('button', { name: 'Log 2 entries' }).click();
  await expect(sheet).toBeHidden();
  await expect(row(page, 'Coop')).toContainText('23.40');
  await expect(row(page, 'Train → Lausanne')).toContainText('Transport');
  await expect(page.locator('.hero-num')).toHaveText('50.70');
  const batch = await listEntries(page, '2026-10-01', '2026-10-31');
  expect(batch.map((e) => e.description).sort()).toEqual(['Coffee', 'Coop', 'Train → Lausanne']);
  expect(batch.find((e) => e.description === 'Coop')).toMatchObject({ source: 'text', category_name: 'Groceries', occurred_at: '2026-10-05T20:14' });

  // ---- edit one
  await row(page, 'Coop').click();
  const editSheet = page.getByRole('dialog', { name: 'Edit entry' });
  await editSheet.getByLabel('Amount').fill('25');
  await editSheet.getByRole('radio', { name: 'Home' }).click();
  await editSheet.getByLabel('Note').fill('Weekly shop');
  await editSheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editSheet).toBeHidden();
  await expect(row(page, 'Coop')).toContainText('25.00');
  await expect(row(page, 'Coop')).toContainText('Home');
  await expect(page.locator('.hero-num')).toHaveText('52.30');

  // ---- delete one, then undo
  await row(page, 'Train → Lausanne').click();
  await editSheet.getByRole('button', { name: 'Delete entry' }).click();
  await expect(editSheet.getByText('Delete this entry?')).toBeVisible();
  await editSheet.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'Train → Lausanne')).toHaveCount(0);
  await expect(page.locator('.hero-num')).toHaveText('29.50');
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Entry deleted');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Train → Lausanne')).toContainText('22.80');
  await expect(page.locator('.hero-num')).toHaveText('52.30');
  const afterUndo = await listEntries(page, '2026-10-01', '2026-10-31');
  expect(afterUndo).toHaveLength(3);
  expect(afterUndo.find((e) => e.description === 'Train → Lausanne')).toMatchObject({ amount_cents: 2280, note: '½ fare', category_name: 'Transport' });

  // ---- overview: totals and bars
  await page.getByRole('button', { name: 'Open the overview' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: 'October 2026' })).toBeVisible();
  await expect(page.locator('.ov-num')).toHaveText('52.30');
  await expect(page.locator('.stats')).toHaveText('3 entries · avg 10.46 / day');
  const bars = page.locator('.bars li');
  await expect(bars).toHaveCount(3);
  await expect(bars.nth(0)).toContainText('Home');
  await expect(bars.nth(0)).toContainText('25.00');
  await expect(bars.nth(0).locator('.fill')).toHaveClass(/acc/);
  await expect(bars.nth(1)).toContainText('Transport');
  await expect(bars.nth(2)).toContainText('Dining');
  await expect(bars.nth(2).locator('.fill')).not.toHaveClass(/acc/);
  await page.getByRole('tab', { name: 'Week' }).click();
  await expect(page).toHaveURL(/p=week/);
  await expect(page.getByRole('heading', { name: 'Week 41 · 5–11 Oct' })).toBeVisible();
  await expect(page.locator('.ov-num')).toHaveText('52.30');
  await page.getByRole('tab', { name: 'Year' }).click();
  await expect(page.getByRole('heading', { name: '2026' })).toBeVisible();
  await expect(page.locator('.stats')).toHaveText('Avg 5.23 / month');
  await page.getByRole('tab', { name: 'Month' }).click();
  await expect(page.getByRole('button', { name: 'Next period' })).toBeDisabled();

  // ---- export CSV
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV →' }).click()]);
  expect(download.suggestedFilename()).toBe('tally-2026-10-01_2026-10-31.csv');
  const csv = (await readFile(await download.path(), 'utf8')).replace(/^﻿/, '');
  const lines = csv.trim().split(/\r?\n/);
  expect(lines[0]).toBe('date,time,amount,currency,description,category,note,source,id');
  expect(lines).toHaveLength(4);
  expect(csv).toContain('2026-10-05,20:14,25.00,CHF,Coop,Home,Weekly shop,text,');

  // ---- ask your data (the period's entries go along as context)
  await page.getByLabel('Ask your data').fill('How much did I spend this month?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer')).toHaveText('You spent 52.30 CHF. Home led at 48%.');
  await expect(page.locator('.answer .mono')).toHaveText('52.30');
  await expect(page.locator('.answer .acc')).toHaveText('Home');
  const ask = gemini.generateBodies.at(-1);
  const askSystem = ask?.systemInstruction?.parts?.[0]?.text ?? '';
  expect(askSystem).toContain('Period: October 2026 (2026-10-01..2026-10-31)');
  expect(askSystem).toContain('Coop | Weekly shop');
  await shot(page, 'flow-overview-ask', { fullPage: true });

  // ---- settings: notifications on this device, then a test notification
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('.topline .ibtn').click();
  await expect(page).toHaveURL(/\/settings$/);
  const device = page.getByRole('switch', { name: 'Notifications on this device' });
  await expect(device).toHaveAttribute('aria-checked', 'false');
  await device.click();
  await expect(device).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('This device', { exact: true })).toBeVisible();
  const reminder = page.getByRole('switch', { name: 'Daily reminder' });
  await reminder.click();
  await expect(reminder).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Reminder time').fill('21:15');
  await page.getByLabel('Reminder time').blur();
  await expect
    .poll(async () => ((await (await page.request.get('/api/settings')).json()) as { settings: Settings }).settings.notifications)
    .toMatchObject({ reminder: true, reminder_time: '21:15' });
  await page.getByRole('button', { name: 'Send a test notification' }).click();
  await expect(page.locator('.toast')).toHaveText('Sent to 1 device.');
  const { sub } = await fakePushState(page);
  if (!sub) throw new Error('no fake subscription');
  const delivered = sink.to(sub.endpoint);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.headers['content-encoding']).toBe('aes128gcm');
  expect(delivered[0]?.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  expect(decryptDelivery(delivered[0]!.body, sub)).toMatchObject({ kind: 'test', title: 'Notifications are on', url: '/settings', lang: 'en' });
  await shot(page, 'flow-settings-notifications-on', { fullPage: true });

  // ---- log out, log back in: everything is still there
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.hero-num')).toHaveText('52.30');
  await expect(row(page, 'Coop')).toContainText('25.00');
  await expect(row(page, 'Train → Lausanne')).toBeVisible();
  await expect(row(page, 'Coffee')).toBeVisible();

  // ---- the key never reached the Worker
  for (const r of apiRequests) {
    expect(JSON.stringify(r.headers())).not.toContain(TEST_KEY);
    expect(r.postData() ?? '').not.toContain(TEST_KEY);
  }
  // …and every parse/ask went to Google with it.
  expect(gemini.generateCalls).toBeGreaterThan(0);
  expect(gemini.requests.filter((r) => r.method === 'POST').every((r) => r.key === TEST_KEY)).toBe(true);
});
