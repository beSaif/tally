/**
 * Recurring bills, end to end: say one, keep one Tally spotted, add one from a calendar day, pay
 * one that asks first, let one log itself, and open a bill. Screenshots: e2e/__screenshots__/bills-*.png.
 * The clock is Monday 5 October 2026, 20:14.
 */
import { expect, test, type Page } from '@playwright/test';
import type { Bill, Entry, NewBill } from '../src/shared/api';
import { listEntries, prepare, seedEntries, shot, signUp } from './support/fixtures';

async function newBill(page: Page, input: Partial<NewBill>): Promise<Bill> {
  const res = await page.request.post('/api/bills', {
    data: { amount_cents: 4_500, description: 'Swisscom mobile', cadence: 'monthly', first_due: '2026-10-14', mode: 'ask', ...input },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { bill: Bill }).bill;
}

async function billsOf(page: Page): Promise<Bill[]> {
  return ((await (await page.request.get('/api/bills')).json()) as { bills: Bill[] }).bills;
}

test('say it: a bill in a sentence, confirmed with its beat, then the next bill on Home', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true, budget_cents: 360_000 } });
  await page.goto('/');

  await page.getByLabel('Describe an expense').fill('Netflix 18.90 every month on the 15th');
  await page.getByRole('button', { name: 'Send' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.kv')).toContainText('Repeats');
  await expect(sheet.locator('.repeat-val')).toHaveText('Monthly, on the 15th');
  await expect(sheet.locator('.kv')).toContainText(/First due\s*Thu 15 Oct/);
  await expect(sheet.getByRole('radio', { name: 'Log it for me' })).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'bills-say-confirm');

  // Edit mode offers the beat too; switch it to "Ask me first" and save.
  await sheet.getByRole('radio', { name: 'Ask me first' }).click();
  await sheet.getByRole('button', { name: 'Save bill' }).click();
  await expect(page.getByRole('status')).toContainText('Netflix saved · first on Thu 15 Oct');
  await expect(page.locator('.bill-strip')).toContainText('Netflix · Thu 15 Oct');
  await expect(page.locator('.bill-strip')).toContainText('18.90');
  await shot(page, 'bills-say-added');

  const [bill] = await billsOf(page);
  expect(bill).toMatchObject({ description: 'Netflix', amount_cents: 1_890, cadence: 'monthly', anchor: '2026-10-15', next_due: '2026-10-15', mode: 'ask', category_name: 'Fun' });
  // Not paid yet, so nothing in the ledger.
  expect(await listEntries(page, '2026-10-01', '2026-10-31')).toEqual([]);
});

test('say it on its day: the first payment is logged and the bill starts at the next', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await page.goto('/');
  await page.getByLabel('Describe an expense').fill('Rent 1250 every month on the 5th');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('dialog').locator('.kv')).toContainText(/Paid\s*Today, 20:14/);
  await page.getByRole('button', { name: 'Save bill' }).click();
  await expect(page.getByRole('status')).toContainText('Rent logged · next on Thu 5 Nov');
  await expect(page.locator('.entries li', { hasText: 'Rent' })).toContainText('1 250.00');
  const [entry] = await listEntries(page, '2026-10-01', '2026-10-31');
  const [bill] = await billsOf(page);
  expect(entry?.bill_id).toBe(bill?.id);
  expect(bill?.next_due).toBe('2026-11-05');
});

test('tally noticed: a habit in past entries becomes a bill from the card on Home', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await seedEntries(
    page,
    ['2026-07-20', '2026-08-20', '2026-09-21'].map((d) => ({ amount_cents: 4_995, description: 'Salt Home internet', category: 'Bills', occurred_at: `${d}T08:00`, source: 'text' as const })),
  );
  await page.goto('/');
  const card = page.locator('.bill-card', { hasText: 'Looks like a bill' });
  await expect(card).toContainText('Salt Home internet');
  await expect(card).toContainText('20 Jul · 20 Aug · 21 Sept, same amount · Monthly');
  await shot(page, 'bills-noticed-card');

  await card.getByRole('button', { name: 'Make it a bill' }).click();
  const sheet = page.getByRole('dialog', { name: 'Spotted in your entries' });
  await expect(sheet.getByLabel('Next due')).toHaveValue('2026-10-21');
  await expect(sheet.getByRole('radio', { name: 'Ask me first' })).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'bills-noticed-confirm');
  await sheet.getByRole('button', { name: 'Save bill' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.bill-strip')).toContainText('Salt Home internet');
  expect((await billsOf(page))[0]).toMatchObject({ description: 'Salt Home internet', next_due: '2026-10-21', mode: 'ask', category_name: 'Bills' });

  // Gone for good: a reload does not suggest it again.
  await page.reload();
  await expect(page.locator('.bill-strip')).toBeVisible();
  await expect(page.locator('.bill-card', { hasText: 'Looks like a bill' })).toHaveCount(0);
});

test('found: the calendar lists what looks like a bill, to keep or dismiss', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  const seed = (description: string, amount_cents: number, days: string[]) =>
    days.map((d) => ({ amount_cents, description, category: 'Bills', occurred_at: `${d}T08:00`, source: 'text' as const }));
  await seedEntries(page, [...seed('Salt Home internet', 4_995, ['2026-07-20', '2026-08-20', '2026-09-21']), ...seed('Spotify', 1_395, ['2026-07-26', '2026-08-26', '2026-09-26'])]);
  await page.goto('/bills');
  await page.getByRole('button', { name: '2 found' }).click();
  const found = page.getByRole('dialog', { name: 'These look like bills' });
  await expect(found.locator('.found li')).toHaveCount(2);
  await shot(page, 'bills-found');
  await found.locator('.found li', { hasText: 'Spotify' }).getByRole('button', { name: 'Not a bill' }).click();
  await found.locator('.found li', { hasText: 'Salt Home internet' }).getByRole('button', { name: 'Keep' }).click();
  await page.getByRole('dialog', { name: 'Spotted in your entries' }).getByRole('button', { name: 'Save bill' }).click();
  await expect(page.getByRole('button', { name: /found$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Wed 21 Oct: 49.95' })).toBeVisible();
});

test('not a bill: dismissing a suggestion keeps it away', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await seedEntries(
    page,
    ['2026-07-05', '2026-08-05', '2026-09-05'].map((d) => ({ amount_cents: 1_200, description: 'Lunch club', category: 'Dining', occurred_at: `${d}T12:00`, source: 'text' as const })),
  );
  await page.goto('/');
  await page.locator('.bill-card').getByRole('button', { name: 'Not a bill' }).click();
  await expect(page.locator('.bill-card')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.hero')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('.bill-card')).toHaveCount(0);
});

test('calendar: the month of bills, a day picked, a bill said for that day', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await newBill(page, { description: 'Rent', amount_cents: 125_000, first_due: '2026-10-01', paid_at: '2026-10-01T09:00', category_id: null });
  await newBill(page, {});
  await newBill(page, { description: 'SIG electricity', amount_cents: 9_640, cadence: 'quarterly', first_due: '2026-10-28' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Bills', exact: true }).click();
  await expect(page).toHaveURL(/\/bills$/);
  await expect(page.locator('.month-title')).toHaveText('October 2026');
  await expect(page.locator('.bill-sums')).toContainText(/Paid\s*1\s250\.00/);
  await expect(page.locator('.bill-sums')).toContainText(/Still to pay\s*141\.40/);
  await expect(page.getByRole('button', { name: 'Wed 14 Oct: 45.00' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Thu 1 Oct: 1.250\.00/ })).toHaveClass(/paid/);
  await shot(page, 'bills-calendar');

  await page.getByRole('button', { name: 'Wed 14 Oct: 45.00' }).click();
  await expect(page.locator('.bill-rows')).toContainText('Swisscom mobile');

  // An empty day: the composer is now about that day.
  await page.getByRole('button', { name: 'Fri 30 Oct: nothing due' }).click();
  await expect(page.getByText('Nothing due · Say a bill to put it on this day.')).toBeVisible();
  const composer = page.getByLabel('Describe an expense');
  await expect(composer).toHaveAttribute('placeholder', 'A bill on 30 Oct — or just talk');
  await shot(page, 'bills-calendar-day');
  await composer.fill('piano lessons 140 monthly');
  await page.getByRole('button', { name: 'Send' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.kv')).toContainText(/First due\s*Fri 30 Oct/);
  await expect(sheet.locator('.repeat-val')).toHaveText('Monthly, on the 30th');
  await shot(page, 'bills-calendar-confirm');
  await sheet.getByRole('button', { name: 'Save bill' }).click();
  await expect(page.getByRole('button', { name: 'Fri 30 Oct: 140.00' })).toBeVisible();
  await expect(page.locator('.bill-rows')).toContainText('Piano Lessons');

  // Next month: everything moved on by its beat.
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.locator('.month-title')).toHaveText('November 2026');
  await expect(page.getByRole('button', { name: /^Sun 1 Nov: 1\s250\.00$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mon 30 Nov: 140.00' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sat 28 Nov: nothing due' })).toBeVisible();
});

test('due today: Paid it logs the entry, moves the bill on, and can be undone', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  const bill = await newBill(page, { first_due: '2026-10-05' });
  await newBill(page, { description: 'Netflix', amount_cents: 1_890, first_due: '2026-10-06', mode: 'auto' });
  await page.goto('/');
  const due = page.locator('.bill-card.due');
  await expect(due).toContainText('Due today');
  await expect(due).toContainText('Swisscom mobile');
  await expect(page.locator('.bill-strip')).toContainText('Netflix · tomorrow');
  await expect(page.locator('.bill-strip')).toContainText('Logs itself');
  await shot(page, 'bills-due');

  await due.getByRole('button', { name: 'Paid it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged · next one Thu 5 Nov');
  await expect(due).toHaveCount(0);
  const row = page.locator('.entries li', { hasText: 'Swisscom mobile' });
  await expect(row).toContainText('45.00');
  await expect(row.locator('.repeat-mark')).toHaveCount(1);
  await shot(page, 'bills-paid');
  expect((await billsOf(page)).find((b) => b.id === bill.id)?.next_due).toBe('2026-11-05');

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(due).toContainText('Swisscom mobile');
  await expect(row).toHaveCount(0);
  expect((await billsOf(page)).find((b) => b.id === bill.id)?.next_due).toBe('2026-10-05');

  // Not yet: gone until tomorrow.
  await due.getByRole('button', { name: 'Not yet' }).click();
  await expect(due).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.bill-strip')).toBeVisible();
  await expect(page.locator('.bill-card.due')).toHaveCount(0);
});

test('logs itself: an automatic bill that came due is in the ledger when Home opens', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  const bill = await newBill(page, { description: 'Gym', amount_cents: 7_900, first_due: '2026-09-05', mode: 'auto' });
  await page.goto('/');
  await expect(page.locator('.entries li', { hasText: 'Gym' })).toContainText('79.00');
  const logged: Entry[] = await listEntries(page, '2026-09-01', '2026-10-31');
  expect(logged.map((e) => e.occurred_at).sort()).toEqual(['2026-09-05T09:00', '2026-10-05T09:00']);
  expect(logged.every((e) => e.bill_id === bill.id)).toBe(true);
  // Opening Home again logs nothing twice.
  await page.reload();
  await expect(page.locator('.entries li', { hasText: 'Gym' })).toHaveCount(1);
  expect(await listEntries(page, '2026-09-01', '2026-10-31')).toHaveLength(2);
});

test('one bill: next dates, what it paid, how it is logged; skip, pay, edit and stop', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  const bill = await newBill(page, { first_due: '2026-09-14', paid_at: '2026-09-14T08:00' });
  await page.goto('/bills?d=2026-10-14');
  await page.getByRole('button', { name: 'Open Swisscom mobile' }).click();
  await expect(page).toHaveURL(new RegExp(`/bills\\?id=${bill.id}`));
  await expect(page.locator('.bill-title')).toHaveText('Swisscom mobile');
  await expect(page.locator('.bill-page .amount-row')).toContainText('CHF · Monthly, on the 14th');
  await expect(page.locator('.next-dates li')).toHaveText([/Wed\s*14 Oct/, /Sat\s*14 Nov/, /Mon\s*14 Dec/]);
  await expect(page.locator('.bill-page .daygrp').first()).toContainText('in 9 days');
  await expect(page.locator('.bill-page .entries li')).toHaveText([/08:00\s*Mon 14 Sept\s*45\.00/]);
  await shot(page, 'bills-one');

  await page.getByRole('radio', { name: 'Log it for me' }).click();
  await expect(page.getByRole('radio', { name: 'Log it for me' })).toHaveAttribute('aria-checked', 'true');
  expect((await billsOf(page))[0]?.mode).toBe('auto');

  await page.getByRole('button', { name: 'Skip this one' }).click();
  await expect(page.locator('.next-dates li').first()).toHaveText(/Sat\s*14 Nov/);
  await page.getByRole('button', { name: 'Mark paid now' }).click();
  await expect(page.locator('.next-dates li').first()).toHaveText(/Mon\s*14 Dec/);
  await expect(page.locator('.bill-page .entries li')).toHaveCount(2);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit bill' });
  await sheet.getByLabel('Amount').fill('49.00');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.bill-num')).toHaveText('49.00');

  await page.getByRole('button', { name: 'Stop this bill' }).click();
  await page.locator('.confirm').getByRole('button', { name: 'Stop this bill' }).click();
  await expect(page).toHaveURL(/\/bills\?d=2026-10-14$/);
  expect(await billsOf(page)).toEqual([]);
  // What it paid stays in the ledger.
  expect((await listEntries(page, '2026-09-01', '2026-10-31')).map((e) => e.bill_id)).toEqual([null, null]);
});

test('French: the bill strings and dates', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { language: 'fr', settings: { setup_complete: true, language: 'fr' } });
  await newBill(page, { description: 'Swisscom', first_due: '2026-10-05' });
  await page.goto('/');
  await expect(page.locator('.bill-card.due')).toContainText('À payer aujourd’hui');
  await expect(page.locator('.bill-card.due')).toContainText('Chaque mois');
  await page.getByRole('button', { name: 'Factures', exact: true }).click();
  await expect(page.locator('.month-title')).toHaveText('octobre 2026');
  await shot(page, 'bills-calendar-fr');
});
