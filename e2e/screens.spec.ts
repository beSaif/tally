/**
 * Every screen with the design page's numbers (October 2026: 1 284.60 of a 2 000 budget), against
 * the real API: home (A.1), earlier months, overview (A.3) with ask (C.3), settings, setup (00.1,
 * 00.2) and the sign-in screens. Screenshots: e2e/__screenshots__/screen-*.png.
 */
import { expect, test } from '@playwright/test';
import { designAccount, prepare, seedEntries, shot, signUp, TEST_KEY, uniqueEmail, uniqueSub } from './support/fixtures';

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
  await expect(page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { selected: true })).toHaveText('Ledger');
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

test('home: an entry saved into last month leaves this month alone and shows under "Show September →"', async ({ page }) => {
  await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await page.goto('/');
  const empty = page.getByText('Nothing logged yet. Type a line or tap the mic.');
  await expect(empty).toBeVisible();
  const total = (await page.locator('.hero-num').textContent()) ?? '';
  // A new account with an empty month: nothing further back to show yet.
  await expect(page.getByRole('button', { name: /^Show / })).toHaveCount(0);

  const composer = page.getByLabel('Describe an expense');
  await composer.fill('Coffee 4.50');
  await composer.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'New expense' });
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  await sheet.getByLabel('When').fill('2026-09-30T08:15');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();

  // October's list and total are unchanged; the way to September appears and leads to the entry.
  await expect(empty).toBeVisible();
  await expect(page.locator('.hero-num')).toHaveText(total);
  await page.getByRole('button', { name: 'Show September →' }).click();
  await expect(page.getByRole('heading', { name: 'September 2026 · 4.50' })).toBeVisible();
  await expect(page.locator('section.month .entries li')).toHaveText(/08:15\s*Coffee\s*Dining\s*4\.50/);
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
  await expect(bars.nth(0)).toHaveText(/Groceries\s*\+9%\s*32%\s*412\.30/);
  await expect(bars.nth(1)).toHaveText(/Dining\s*\+18%\s*22%\s*286\.10/);
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

test('overview: a question asked before the totals load still sends the totals per category', async ({ page }) => {
  const { gemini } = await prepare(page, { withKey: true });
  await designAccount(page);
  // A slow connection: the period's summary has not arrived when the question is asked.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/summary\?/, async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await page.goto('/overview');
  await page.getByLabel('Ask your data').fill('Where did most of my money go this month?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.answer')).toHaveText(/Groceries led at 32%\.$/);
  await expect(page.locator('.ov-total')).toHaveClass(/pending/);
  const system = (gemini.generateBodies.at(-1)?.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n');
  expect(system).toContain('By category:\n- Groceries 412.30 CHF\n- Dining 286.10 CHF\n- Bills 240.00 CHF\n- Transport 148.80 CHF\n- Fun 119.40 CHF\n- Shopping 78.00 CHF\n');
  release();
  await expect(page.locator('.ov-total')).not.toHaveClass(/pending/);
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

  // Account: the Google address, no password to change.
  await expect(page.getByText('With Google')).toBeVisible();

  // Delete account: confirmed by typing the email.
  await page.getByRole('button', { name: 'Delete account' }).click();
  const forever = page.getByRole('button', { name: 'Delete forever' });
  await expect(forever).toBeDisabled();
  await page.getByLabel('Email', { exact: true }).fill(account.email.toUpperCase());
  await expect(forever).toBeEnabled();
  await page.getByRole('heading', { name: 'Account' }).scrollIntoViewIfNeeded();
  await shot(page, 'screen-settings-delete');
  await forever.click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

test('settings: the key is checked once when shown and once per model edit, never per keystroke', async ({ page }) => {
  const { gemini } = await prepare(page, { withKey: true });
  await signUp(page, { settings: { setup_complete: true } });
  await page.goto('/settings');
  const checked = () => gemini.requests.filter((r) => r.method === 'GET').map((r) => decodeURIComponent(new URL(r.url).pathname.split('/models/')[1] ?? ''));
  const status = (text: string) => page.getByRole('status').filter({ hasText: text });
  await expect(status('Key works · gemini-2.5-flash')).toBeVisible();
  expect(checked()).toEqual(['gemini-2.5-flash']);

  // A saved model change checks the saved key again, once.
  const model = page.getByLabel('Model', { exact: true });
  await model.fill('gemini-2.5-pro');
  await model.press('Enter');
  await expect(status('Key works · gemini-2.5-pro')).toBeVisible();
  expect(checked()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);

  // Typing a model while changing the key re-checks the new key once typing pauses.
  await page.getByRole('button', { name: 'Change', exact: true }).first().click();
  await page.getByLabel('Google AI Studio API key').fill(TEST_KEY);
  await expect(status('Key works · gemini-2.5-pro')).toBeVisible();
  const before = checked().length;
  await model.fill('');
  await model.pressSequentially('gemini-2.5-flash-lite', { delay: 30 });
  await expect(status('Key works · gemini-2.5-flash-lite')).toBeVisible();
  expect(checked().slice(before)).toEqual(['gemini-2.5-flash-lite']);
});

test('setup (00.1, 00.2), sign-in and privacy screens', async ({ page }) => {
  const { google } = await prepare(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await shot(page, 'screen-login');

  // Back from Google without a session: the screen says why.
  await page.goto('/login?error=failed');
  await expect(page.getByRole('alert')).toHaveText('Google could not sign you in. Try again.');
  await shot(page, 'screen-login-error');
  google.cancelNext = true;
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/login\?error=cancelled$/);
  await expect(page.getByRole('alert')).toHaveText('Sign-in was cancelled. Try again whenever you like.');
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);

  // The privacy policy is readable before signing in.
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await expect(page.getByText('Your Google password never touches Tally.')).toBeVisible();
  await shot(page, 'screen-privacy', { fullPage: true });
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/login/);

  // A Google account Tally has never seen lands in setup.
  google.nextUser = { sub: uniqueSub(), email: uniqueEmail('setup') };
  await page.getByRole('link', { name: 'Continue with Google' }).click();
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

test('install: Settings uses the captured prompt; the first log offers it once', async ({ page }) => {
  await prepare(page, { withKey: true });
  await designAccount(page);
  await page.goto('/');
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');
  // What Chromium fires when the app is installable (it does not, headless).
  await page.evaluate(() => {
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => {
        (window as unknown as { __prompted: number }).__prompted = ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1;
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    });
    window.dispatchEvent(event);
  });

  await page.getByLabel('Describe an expense').fill('Coffee 4.50');
  await page.getByLabel('Describe an expense').press('Enter');
  await page.getByRole('dialog', { name: 'New expense' }).getByRole('button', { name: 'Save', exact: true }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Add Tally to your Home Screen');
  await shot(page, 'screen-home-install-toast');
  await toast.getByRole('button', { name: 'Install' }).click();
  expect(await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted)).toBe(1);

  // A prompt can be used once; a new one (the browser fires it again) shows in Settings.
  await page.evaluate(() => {
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => {
          (window as unknown as { __prompted: number }).__prompted++;
        },
        userChoice: Promise.resolve({ outcome: 'accepted' as const }),
      }),
    );
  });
  await page.locator('.topline .ibtn').click();
  await page.getByRole('button', { name: 'Install Tally' }).click();
  expect(await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted)).toBe(2);
  await expect(page.getByRole('button', { name: 'Install Tally' })).toHaveCount(0);

  // Offered once per device only.
  await page.goto('/');
  await page.getByLabel('Describe an expense').fill('Coffee 3.80');
  await page.getByLabel('Describe an expense').press('Enter');
  await page.getByRole('dialog', { name: 'New expense' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.entries li.fresh')).toContainText('3.80');
  await expect(toast).toHaveCount(0);
});

test.describe('notifications where push is not available', () => {
  test('a browser without Web Push says so', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { PushManager?: unknown }).PushManager;
    });
    await prepare(page, { withKey: true });
    await designAccount(page);
    await page.goto('/settings');
    await expect(page.getByText('This browser cannot receive notifications.')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Notifications on this device' })).toHaveCount(0);
  });

  test.describe('on an iPhone, in Safari', () => {
    test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });

    test('asks to add Tally to the Home Screen first', async ({ page }) => {
      await prepare(page, { withKey: true });
      await designAccount(page);
      await page.goto('/settings');
      await expect(page.getByText('On iPhone, add Tally to your Home Screen first, then enable notifications.')).toBeVisible();
      await expect(page.getByText('In Safari, tap Share, then “Add to Home Screen”, and open Tally from your Home Screen.')).toBeVisible();
      await expect(page.getByText('In Safari, tap Share, then “Add to Home Screen”.')).toBeVisible();
      await page.getByRole('heading', { name: 'Notifications' }).scrollIntoViewIfNeeded();
      await shot(page, 'screen-settings-ios');
    });
  });
});
