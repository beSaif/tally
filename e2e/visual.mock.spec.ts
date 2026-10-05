/**
 * Visual + behaviour checks against the in-browser mock API (no Worker routes needed).
 * Every screen and state is screenshotted into e2e/__screenshots__/ (390×844 @2x) for review
 * against design/index.html. Run: `E2E_VISUAL_PORT=5174 npx playwright test --project=visual`.
 */
import { expect, test } from '@playwright/test';
import { MockApi } from './support/mock-api';
import { BATCH_TEXT, MockGemini } from './support/mock-gemini';
import { FIXED_NOW, TEST_KEY, prepare, pressMic, shot } from './support/fixtures';

test.describe('auth', () => {
  test('log in, errors, sign up with invite code', async ({ page }) => {
    const api = new MockApi({ inviteCode: 'letmein' });
    await prepare(page, { api });
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    await shot(page, 'auth-01-login');

    await page.getByLabel('Email').fill('lea@example.com');
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That email or password is not right.');
    await shot(page, 'auth-02-login-error');

    await page.getByRole('link', { name: 'New here? Create an account' }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await shot(page, 'auth-03-signup');

    await page.getByLabel('Email').fill('lea@example.com');
    await page.getByLabel('Password').fill('correct horse');
    await page.getByRole('button', { name: 'Show' }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toHaveText('This Tally needs an invite code.');
    await expect(page.getByLabel('Invite code')).toBeVisible();
    await shot(page, 'auth-04-signup-invite');

    await page.getByLabel('Invite code').fill('letmein');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: /Bring your/ })).toBeVisible();
    const signup = api.calls.find((c) => c.path === '/auth/signup' && (c.body as { invite_code?: string }).invite_code);
    expect(signup?.body).toMatchObject({ email: 'lea@example.com', language: 'en', invite_code: 'letmein' });
  });
});

test.describe('setup', () => {
  test('key check, then defaults', async ({ page }) => {
    const api = new MockApi({ loggedIn: true, setupComplete: false });
    await prepare(page, { api });
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByText('Step 01 / 02')).toBeVisible();
    const cont = page.getByRole('button', { name: 'Continue' });
    await expect(cont).toBeDisabled();
    await shot(page, 'setup-01-key-empty');

    const field = page.getByLabel('Google AI Studio API key');
    await field.fill('AIza-bad-key-123456789');
    await expect(page.getByRole('status').filter({ hasText: 'Key rejected by Google' })).toBeVisible();
    await shot(page, 'setup-02-key-rejected');

    await field.fill(TEST_KEY);
    await field.blur();
    await expect(page.getByText('Key works · gemini-2.5-flash')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google AI Studio API key' })).toHaveText('AIza••••••••••••••Qx4');
    await expect(cont).toBeEnabled();
    await shot(page, 'setup-03-key-ok');

    await cont.click();
    await expect(page.getByText('Step 02 / 02')).toBeVisible();
    await expect(page.getByRole('heading', { name: /A few/ })).toBeVisible();
    await page.getByLabel('Budget').fill('2000');
    await page.getByLabel('Budget').blur();
    await shot(page, 'setup-04-defaults');

    await page.getByRole('button', { name: 'Health' }).click();
    await expect(page.getByRole('button', { name: 'Health' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByLabel('New category').fill('Kids');
    await page.getByLabel('New category').press('Enter');
    await expect(page.getByRole('button', { name: 'Kids' })).toBeVisible();
    await shot(page, 'setup-05-defaults-edited');

    await page.getByRole('button', { name: 'Start logging' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(api.settings).toMatchObject({ currency: 'CHF', budget_cents: 200000, setup_complete: true });
    expect(api.categories.map((c) => c.name)).toEqual(['Groceries', 'Dining', 'Transport', 'Home', 'Fun', 'Shopping', 'Bills', 'Kids']);
    expect(await page.evaluate(() => localStorage.getItem('tally.gemini.key'))).toBe(TEST_KEY);
    await shot(page, 'setup-06-home-empty');
  });
});

test.describe('home', () => {
  test('ledger with budget, earlier months', async ({ page }) => {
    const api = new MockApi({ loggedIn: true, setupComplete: true, seed: 'design' });
    await prepare(page, { api, withKey: true });
    await page.goto('/');
    await expect(page.locator('.hero-num')).toHaveText('1 284.60');
    await expect(page.getByText('64% of 2 000')).toBeVisible();
    await expect(page.getByText('26 days left')).toBeVisible();
    await expect(page.locator('.daygrp').first()).toContainText('Today');
    await expect(page.locator('.daygrp').first()).toContainText('22.40');
    await shot(page, 'home-01-ledger');
    await shot(page, 'home-02-ledger-full', { fullPage: true });

    await page.getByRole('button', { name: 'Show September →' }).click();
    await expect(page.getByText('September 2026 · 1 102.30')).toBeVisible();
    await page.getByText('September 2026 · 1 102.30').scrollIntoViewIfNeeded();
    await shot(page, 'home-03-september');
  });
});

test.describe('overview', () => {
  test('month, week, year, ask', async ({ page }) => {
    const api = new MockApi({ loggedIn: true, setupComplete: true, seed: 'design' });
    const { gemini } = await prepare(page, { api, withKey: true });
    await page.goto('/overview');
    await expect(page.locator('.ov-num')).toHaveText('1 284.60');
    await expect(page.locator('.bars li').first()).toContainText('Groceries');
    await shot(page, 'overview-01-month');
    await shot(page, 'overview-02-month-full', { fullPage: true });

    await page.getByRole('tab', { name: 'Week' }).click();
    await expect(page).toHaveURL(/p=week/);
    await expect(page.getByRole('heading', { name: /Week 41/ })).toBeVisible();
    await shot(page, 'overview-03-week');
    await page.getByRole('tab', { name: 'Year' }).click();
    await expect(page.getByRole('heading', { name: '2026' })).toBeVisible();
    await shot(page, 'overview-04-year');

    await page.getByRole('tab', { name: 'Month' }).click();
    gemini.hold();
    await page.getByLabel('Ask your data').fill('How much on groceries this month?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Gemini is thinking' })).toBeVisible();
    await shot(page, 'overview-05-ask-thinking', { fullPage: true });
    gemini.release();
    await expect(page.locator('.answer')).toContainText('You spent 1 284.60 CHF');
    await expect(page.locator('.answer .mono')).toHaveText('1 284.60');
    await expect(page.locator('.answer .acc')).toHaveText('Groceries');
    await page.locator('.answer').scrollIntoViewIfNeeded();
    await shot(page, 'overview-06-ask-answer');
    await shot(page, 'overview-07-ask-answer-full', { fullPage: true });
  });
});

test.describe('settings', () => {
  test('all sections, notifications on', async ({ page }) => {
    const api = new MockApi({ loggedIn: true, setupComplete: true, seed: 'design', devices: [{ user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' }] });
    await prepare(page, { api, withKey: true });
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await shot(page, 'settings-01-top');
    await shot(page, 'settings-02-full', { fullPage: true });

    await page.getByRole('switch', { name: 'Notifications on this device' }).click();
    await expect(page.getByRole('switch', { name: 'Notifications on this device' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('This device', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Send a test notification' }).click();
    await expect(page.locator('.toast')).toHaveText('Sent to 1 device.');
    await page.getByRole('heading', { name: 'Notifications' }).scrollIntoViewIfNeeded();
    await shot(page, 'settings-03-notifications');
    await shot(page, 'settings-04-full-on', { fullPage: true });
  });
});

void FIXED_NOW;
void BATCH_TEXT;
void pressMic;
