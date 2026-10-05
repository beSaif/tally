/**
 * Every screen with the design page's numbers (October 2026: 1 284.60 of a 2 000 budget), against
 * the real API: home (A.1), earlier months, overview (A.3) with ask (C.3), settings, setup (00.1,
 * 00.2) and the sign-in screens. Screenshots: e2e/__screenshots__/screen-*.png.
 */
import { expect, test } from '@playwright/test';
import { designAccount, PASSWORD, prepare, seedEntries, shot, signUp, TEST_KEY, uniqueEmail } from './support/fixtures';

test('home (A.1): month total, budget, days left, day groups; earlier months; refetch when visible', async ({ page }) => {
  await prepare(page, { withKey: true });
  await designAccount(page);
  await page.goto('/');
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');
  await expect(page.locator('.hero .meta-row')).toHaveText(/64% of 2 000\s*26 days left/);
  await expect(page.locator('.hero .fill')).toHaveAttribute('style', /width: 64%/);
  await expect(page.locator('.daygrp').nth(0)).toHaveText(/Today\s*22\.40/);
  await expect(page.locator('.daygrp').nth(1)).toHaveText(/Yesterday\s*68\.20/);
  await expect(page.locator('.daygrp').nth(2)).toHaveText(/Sat 03\s*349\.40/);
  await expect(page.locator('.entries li').first()).toHaveText(/18:05\s*TPG ticket\s*Transport\s*3\.00/);
  await expect(page.getByRole('button', { name: 'Open the overview' })).toHaveText('Oct 2026');
  await shot(page, 'screen-home');
  await shot(page, 'screen-home-full', { fullPage: true });

  // Earlier months load under a month header, one at a time.
  await page.getByRole('button', { name: 'Show September →' }).click();
  await expect(page.getByRole('heading', { name: 'September 2026 · 1 102.30' })).toBeVisible();
  await page.getByRole('heading', { name: 'September 2026 · 1 102.30' }).scrollIntoViewIfNeeded();
  await shot(page, 'screen-home-september');
  await page.getByRole('button', { name: 'Show August →' }).click();
  await expect(page.getByRole('heading', { name: /August 2026/ })).toBeVisible();
  await expect(page.getByText('Nothing logged.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Show / })).toHaveCount(0);

  // Another device logs something: it shows up when this tab comes back to the front.
  await seedEntries(page, [{ amount_cents: 1250, description: 'Pharmacy', category: 'Health', occurred_at: '2026-10-05T19:00', source: 'text' }]);
  await page.waitForTimeout(2100);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.entries li', { hasText: 'Pharmacy' })).toContainText('12.50');
  await expect(page.locator('.hero-num')).toHaveText('1 297.10');
});

test('home: empty month without a budget; ?compose=1 focuses the composer', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await page.goto('/?compose=1');
  await expect(page.getByLabel('Describe an expense')).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Nothing logged yet. Type a line or tap the mic.')).toBeVisible();
  await expect(page.locator('.hero .meta-row')).toHaveText('26 days left');
  await expect(page.locator('.hero .track')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show / })).toHaveCount(0);
  await page.getByLabel('Describe an expense').blur();
  await shot(page, 'screen-home-empty');
});

test('home: over budget turns the bar orange', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true, budget_cents: 100_000 } });
  await seedEntries(page, [{ amount_cents: 128_460, description: 'Rent share', category: 'Home', occurred_at: '2026-10-01T09:00', source: 'manual' }]);
  await page.goto('/');
  await expect(page.locator('.hero .meta-row')).toHaveText(/128% of 1 000/);
  await expect(page.locator('.hero .fill')).toHaveClass(/acc/);
});

test('overview (A.3 + C.3): month, week, year, previous periods, deltas, ask', async ({ page }) => {
  const { gemini } = await prepare(page, { withKey: true });
  await designAccount(page);
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'October 2026' })).toBeVisible();
  await expect(page.locator('.ov-num')).toHaveText('1 284.60');
  await expect(page.locator('.stats')).toHaveText('32 entries · avg 256.92 / day');
  const bars = page.locator('.bars li');
  await expect(bars).toHaveCount(6);
  await expect(bars.nth(0)).toHaveText(/Groceries\s*\+9%\s*412\.30/);
  await expect(bars.nth(1)).toHaveText(/Dining\s*\+18%\s*286\.10/);
  await expect(bars.nth(1).locator('.fill')).toHaveAttribute('style', /width: 69%/);
  await expect(page.getByRole('link', { name: 'Export CSV →' })).toHaveAttribute('href', '/api/export.csv?from=2026-10-01&to=2026-10-31');
  await shot(page, 'screen-overview-month');

  // September: no previous totals in August, so no deltas.
  await page.getByRole('button', { name: 'Previous period' }).click();
  await expect(page.getByRole('heading', { name: 'September 2026' })).toBeVisible();
  await expect(page.locator('.ov-num')).toHaveText('1 102.30');
  await expect(page.locator('.bars .delta')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next period' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next period' }).click();
  await expect(page.locator('.ov-num')).toHaveText('1 284.60');

  await page.getByRole('tab', { name: 'Week' }).click();
  await expect(page).toHaveURL(/p=week/);
  await expect(page.getByRole('heading', { name: 'Week 41 · 5–11 Oct' })).toBeVisible();
  await expect(page.locator('.ov-num')).toHaveText('22.40');
  await shot(page, 'screen-overview-week');
  await page.getByRole('button', { name: 'Previous period' }).click();
  await expect(page.getByRole('heading', { name: 'Week 40 · 28 Sept – 4 Oct' })).toBeVisible();
  await expect(page.locator('.ov-num')).toHaveText('1 358.70');
  // The anchor day follows the tabs: back to this week before looking at the year and the month.
  await page.getByRole('button', { name: 'Next period' }).click();
  await expect(page.getByRole('button', { name: 'Next period' })).toBeDisabled();

  await page.getByRole('tab', { name: 'Year' }).click();
  await expect(page.getByRole('heading', { name: '2026' })).toBeVisible();
  await expect(page.locator('.stats')).toHaveText('Avg 238.69 / month');
  await shot(page, 'screen-overview-year');

  await page.getByRole('tab', { name: 'Month' }).click();
  gemini.hold();
  await page.getByLabel('Ask your data').fill('Where did most of my money go this month?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Gemini is thinking' })).toBeVisible();
  await shot(page, 'screen-overview-ask-thinking', { fullPage: true });
  gemini.release();
  await expect(page.locator('.answer')).toHaveText('You spent 1 284.60 CHF. Groceries led at 32%.');
  await expect(page.locator('.answer .acc')).toHaveText('Groceries');
  await page.locator('.answer').scrollIntoViewIfNeeded();
  await shot(page, 'screen-overview-ask');
  await shot(page, 'screen-overview-ask-full', { fullPage: true });
});

test('settings: every section', async ({ page }) => {
  await prepare(page, { withKey: true });
  const account = await designAccount(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('.key-value')).toHaveText('AIza••••••Qx4');
  await expect(page.getByLabel('Budget')).toHaveValue('2 000.00');
  await expect(page.getByText(account.email)).toBeVisible();
  await shot(page, 'screen-settings');
  await shot(page, 'screen-settings-full', { fullPage: true });

  // Categories: tap → confirm removal.
  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(page.getByText('Remove Fun? Entries keep their history as Other.')).toBeVisible();
  await page.getByRole('heading', { name: 'Categories' }).scrollIntoViewIfNeeded();
  await shot(page, 'screen-settings-category-remove');
  await page.locator('.confirm').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fun', exact: true })).toHaveCount(0);

  // Change the key: the same live check as setup.
  await page.getByRole('button', { name: 'Change', exact: true }).first().click();
  await page.getByLabel('Google AI Studio API key').fill('AIza-wrong-key-123456789');
  await expect(page.getByRole('status').filter({ hasText: 'Key rejected by Google' })).toBeVisible();
  await page.getByRole('heading', { name: 'Gemini' }).scrollIntoViewIfNeeded();
  await shot(page, 'screen-settings-key-change');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Change password, inline.
  await page.getByRole('button', { name: 'Change', exact: true }).last().click();
  await page.getByLabel('Current password').fill('not it at all');
  await page.getByLabel('New password').fill('a much better one');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('That password is not right.')).toBeVisible();
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast')).toHaveText('Password changed.');

  // Delete account: confirmed by typing the email.
  await page.getByRole('button', { name: 'Delete account' }).click();
  const forever = page.getByRole('button', { name: 'Delete forever' });
  await expect(forever).toBeDisabled();
  await page.getByLabel('Email', { exact: true }).last().fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill('a much better one');
  await page.getByRole('heading', { name: 'Account' }).scrollIntoViewIfNeeded();
  await shot(page, 'screen-settings-delete');
  await forever.click();
  await expect(page).toHaveURL(/\/signup$/);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

test('setup (00.1, 00.2) and sign-in screens', async ({ page }) => {
  await prepare(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await shot(page, 'screen-login');
  await page.getByLabel('Email').fill(uniqueEmail('nobody'));
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That email or password is not right.');
  await shot(page, 'screen-login-error');

  // Signing up with an email that already has an account.
  const taken = uniqueEmail('taken');
  await signUp(page, { email: taken });
  await page.request.post('/api/auth/logout');
  await page.goto('/signup');
  await page.getByLabel('Email').fill(taken);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Show' }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('There is already an account for this email.');
  await shot(page, 'screen-signup-taken');

  await page.getByLabel('Email').fill(uniqueEmail('setup'));
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Step 01 / 02')).toBeVisible();
  await shot(page, 'screen-setup-key-empty');
  await page.getByLabel('Google AI Studio API key').fill(TEST_KEY);
  await page.getByLabel('Google AI Studio API key').blur();
  await expect(page.getByRole('button', { name: 'Google AI Studio API key' })).toHaveText('AIza••••••••••••••Qx4');
  await shot(page, 'screen-setup-key-ok');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Budget').fill('2000');
  await page.getByLabel('Budget').blur();
  await shot(page, 'screen-setup-defaults');
});

test('sign-up screen when the server asks for an invite code', async ({ page }) => {
  // The local Worker runs without INVITE_CODE, so this one answer is forced: everything else is real.
  await page.route('**/api/auth/signup', (route) =>
    route.request().postDataJSON()?.invite_code
      ? route.continue()
      : route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invite_required', message: 'An invite code is required' } }) }),
  );
  await prepare(page);
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail('invite'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('This Tally needs an invite code.');
  await expect(page.getByLabel('Invite code')).toBeVisible();
  await shot(page, 'screen-signup-invite');
  await page.getByLabel('Invite code').fill('anything');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/setup$/);
});
