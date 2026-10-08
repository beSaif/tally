/**
 * Analytics and the monthly report, on the design account (October 2026: 1 284.60 of a 2 000
 * budget; September 1 102.30) plus May–August, so trends have six months to show.
 * Screenshots: e2e/__screenshots__/analytics-*.png, report-*.png.
 */
import type { NewEntry } from '@shared/api';
import { expect, test, type Page } from '@playwright/test';
import { designAccount, prepare, seedEntries, shot } from './support/fixtures';

const MONTHS: Array<[string, Array<[string, number]>]> = [
  ['2026-05', [['Groceries', 380], ['Dining', 210], ['Transport', 120], ['Bills', 240], ['Fun', 60]]],
  ['2026-06', [['Groceries', 410], ['Dining', 260], ['Transport', 135], ['Bills', 240], ['Fun', 140], ['Shopping', 90]]],
  ['2026-07', [['Groceries', 350], ['Dining', 310], ['Transport', 220], ['Bills', 240], ['Fun', 95]]],
  ['2026-08', [['Groceries', 390], ['Dining', 240], ['Transport', 160], ['Bills', 240], ['Shopping', 120]]],
];

function earlierMonths(): NewEntry[] {
  return MONTHS.flatMap(([month, rows]) =>
    rows.map(([category, amount], i) => ({ amount_cents: amount * 100, description: category, category, occurred_at: `${month}-${String(10 + i).padStart(2, '0')}T12:00`, source: 'text' as const })),
  );
}

async function sixMonthAccount(page: Page): Promise<void> {
  await prepare(page, { withKey: true });
  await designAccount(page);
  await seedEntries(page, earlierMonths());
}

test('ledger | analytics switch: one tap each way, back returns to the ledger', async ({ page }) => {
  await sixMonthAccount(page);
  await page.goto('/');
  const views = page.getByRole('tablist', { name: 'Views' });
  await expect(views.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, 'analytics-switch-ledger');

  await views.getByRole('tab', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator('.ov-num')).toHaveText('1 284.60');
  await expect(page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
  // 5 October compares with 1–5 September, when only the bills had come in.
  await expect(page.locator('.bars-cap')).toHaveText('Change vs 1–5 Sept');
  await expect(page.locator('.bars li').first()).toHaveText(/^Groceries\s*32%\s*412\.30/);
  await expect(page.locator('.bars li', { hasText: 'Bills' })).toHaveText(/Bills\s*0%\s*19%\s*240\.00/);
  // Bills are a fixed cost out of the box.
  await expect(page.locator('.ov-total .split')).toHaveText('Fixed 240.00 · Day-to-day 1 044.60');
  await shot(page, 'analytics-month');

  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Ledger' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');

  // Analytics remembers the period it was left on.
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Analytics' }).click();
  await page.getByRole('tab', { name: 'Week' }).click();
  await page.getByRole('button', { name: 'Previous period' }).click();
  await expect(page.getByRole('heading', { name: 'Week 40 · 28 Sept – 4 Oct' })).toBeVisible();
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Ledger' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Analytics' }).click();
  await expect(page.getByRole('heading', { name: 'Week 40 · 28 Sept – 4 Oct' })).toBeVisible();
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Next period' }).click();
  await expect(page.getByRole('heading', { name: 'October 2026' })).toBeVisible();
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Ledger' }).click();

  // The phone's back button does the same as the Ledger tab.
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(/\/overview\?p=month$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('category drill-down: share, six-month trend and the entries; editing one recounts', async ({ page }) => {
  await sixMonthAccount(page);
  await page.goto('/overview');
  await page.locator('.bar-btn', { hasText: 'Transport' }).click();
  const sheet = page.getByRole('dialog', { name: 'Transport' });
  await expect(sheet.locator('.ov-num')).toHaveText('148.80');
  await expect(sheet.locator('.stats')).toHaveText('12% of October 2026 · 6 entries');
  await expect(sheet.locator('.cols li')).toHaveCount(6);
  await expect(sheet.locator('.cols li .m')).toHaveText(['May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct']);
  await expect(sheet.locator('.cols li .v')).toHaveText(['120', '135', '220', '160', '120', '149']);
  await expect(sheet.locator('.entries li')).toHaveCount(6);
  // Every entry is Transport here, so the rows do not repeat it.
  await expect(sheet.locator('.entries li').first()).toHaveText(/^18:05\s*TPG ticket\s*3\.00$/);
  // The average of May–September, drawn across the columns.
  await expect(sheet.locator('.sec-aside')).toHaveText(' · avg 151');
  await expect(sheet.locator('.cols .avg')).toHaveCount(6);
  await shot(page, 'analytics-category');

  // An entry opens for editing; saving comes back to Transport with the new numbers.
  await sheet.locator('.entries li', { hasText: 'Taxi' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit entry' });
  await edit.getByRole('radio', { name: 'Fun' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  const back = page.getByRole('dialog', { name: 'Transport' });
  await expect(back.locator('.ov-num')).toHaveText('110.20');
  await expect(back.locator('.entries li')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bar-btn', { hasText: 'Transport' })).toContainText('110.20');
  await expect(page.locator('.bar-btn', { hasText: 'Fun' })).toContainText('158.00');

  // Year view: the trend ends at the current month.
  await page.getByRole('tab', { name: 'Year' }).click();
  await page.locator('.bar-btn', { hasText: 'Groceries' }).click();
  await expect(page.getByRole('dialog', { name: 'Groceries' }).locator('.cols li.on .m')).toHaveText('Oct');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('monthly report: totals, budget, change, categories, biggest expenses, six months; PDF via print', async ({ page }) => {
  await sixMonthAccount(page);
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Previous period' }).click();
  await page.getByRole('link', { name: 'September report →' }).click();
  await expect(page).toHaveURL(/\/report\?m=2026-09$/);

  await expect(page.locator('.rp-title')).toHaveText('September 2026');
  await expect(page.locator('.rp-kicker')).toHaveText('Monthly report');
  await expect(page.locator('.ov-num')).toHaveText('1 102.30');
  await expect(page.locator('.rp-total .stats')).toHaveText('55% of the 2 000 budget');
  await expect(page.locator('.rp-vs').first()).toHaveText('↓4% vs August (−47.70)');
  await expect(page.locator('.rp-vs').nth(1)).toHaveText('Fixed 240.00 · Day-to-day 862.30');
  await expect(page.locator('.rp-stats dd')).toHaveText(['10', '36.74', /Tue 01\s*240\.00/]);
  await expect(page.locator('.bars li').first()).toHaveText(/Groceries\s*↓3%\s*34%\s*380\.00/);
  await expect(page.locator('.rp-biggest li')).toHaveCount(5);
  await expect(page.locator('.rp-biggest li').first()).toHaveText(/1 Sept\s*Bills\s*Bills\s*240\.00/);
  await expect(page.locator('.cols li.on .m')).toHaveText('Sept');
  // May–August averaged; April had nothing logged, so it does not count.
  await expect(page.locator('.sec-aside')).toHaveText(' · avg 1 163');
  await shot(page, 'report-september');
  await shot(page, 'report-september-full', { fullPage: true });

  // Save as PDF prints the page under a file-friendly title.
  await page.evaluate(() => {
    (window as unknown as { printedAs: string[] }).printedAs = [];
    window.print = () => (window as unknown as { printedAs: string[] }).printedAs.push(document.title);
  });
  await page.getByRole('button', { name: 'Save as PDF' }).click();
  expect(await page.evaluate(() => (window as unknown as { printedAs: string[] }).printedAs)).toEqual(['Tally · September 2026']);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.topline')).toBeHidden();
  await expect(page.locator('.rp-actions')).toBeHidden();
  await shot(page, 'report-september-print', { fullPage: true });
  await page.emulateMedia({ media: 'screen' });

  // The month after is reachable; the current month is "in progress" and cannot go further.
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page).toHaveURL(/\/report\?m=2026-10$/);
  await expect(page.locator('.rp-kicker')).toHaveText('Month in progress');
  await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled();

  // Back leads to Analytics, even when the report was the first page opened (a notification).
  await page.goto('/report');
  await expect(page.locator('.rp-title')).toHaveText('September 2026');
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/overview$/);
});

test('a month with nothing logged says so', async ({ page }) => {
  await prepare(page, { withKey: true });
  await designAccount(page);
  await page.goto('/report?m=2026-08');
  await expect(page.locator('.ov-note')).toHaveText('Nothing logged in August.');
});

test('category budget and fixed cost, set from the drill-down', async ({ page }) => {
  await sixMonthAccount(page);
  await page.goto('/overview');
  await page.locator('.bar-btn', { hasText: 'Dining' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dining' });
  await expect(sheet.locator('.cat-settings')).toContainText('Monthly budget');
  await sheet.getByRole('button', { name: 'Set' }).click();
  await sheet.getByLabel('Monthly budget').fill('250');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.locator('.cat-budget .meta-row')).toHaveText(/114% of the 250 budget\s*36\.10 over/);
  await expect(sheet.locator('.ov-num')).toHaveClass(/over/);
  await sheet.evaluate((el) => el.scrollTo(0, 0));
  await shot(page, 'analytics-category-budget');

  // Dining as a fixed cost moves it to the fixed side of the split.
  await sheet.getByRole('switch', { name: 'Fixed cost' }).click();
  await expect(sheet.getByRole('switch', { name: 'Fixed cost' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ov-total .split')).toHaveText('Fixed 526.10 · Day-to-day 758.50');
  await expect(page.locator('.bar-btn', { hasText: 'Dining' }).locator('.amt')).toHaveClass(/over/);
  await expect(page.locator('.bar-btn', { hasText: 'Dining' }).locator('.mark')).toHaveCount(1);

  // Saved on the server: a reload keeps both.
  await page.reload();
  await page.locator('.bar-btn', { hasText: 'Dining' }).click();
  await expect(page.getByRole('dialog', { name: 'Dining' }).locator('.cat-settings')).toContainText('250');
  await page.getByRole('dialog', { name: 'Dining' }).getByRole('button', { name: 'Change' }).click();
  await page.getByRole('dialog', { name: 'Dining' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('dialog', { name: 'Dining' }).locator('.cat-budget')).toHaveCount(0);
});

test('entries without a category: a nudge opens them, and sorting one clears it', async ({ page }) => {
  await sixMonthAccount(page);
  await seedEntries(page, [{ amount_cents: 1250, description: 'Pharmacy', occurred_at: '2026-10-04T18:00', source: 'text' }]);
  await page.goto('/overview');
  await page.getByRole('button', { name: '1 entry has no category · Sort it →' }).click();
  const sheet = page.getByRole('dialog', { name: 'Other' });
  await expect(sheet.locator('.cat-hint')).toHaveText('Tap an entry to give it a category.');
  await expect(sheet.locator('.cat-settings')).toHaveCount(0);
  await sheet.locator('.entries li', { hasText: 'Pharmacy' }).click();
  await page.getByRole('dialog', { name: 'Edit entry' }).getByRole('radio', { name: 'Health' }).click();
  await page.getByRole('dialog', { name: 'Edit entry' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog', { name: 'Other' }).locator('.entries li')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.nudge')).toHaveCount(0);
  await expect(page.locator('.bar-btn', { hasText: 'Health' })).toContainText('12.50');
});

test('report summary: Gemini writes it on request, and it is kept for the month', async ({ page }) => {
  const { gemini } = await prepare(page, { withKey: true });
  await designAccount(page);
  await seedEntries(page, earlierMonths());
  await page.goto('/report?m=2026-09');
  await page.getByRole('button', { name: /Summarize with Gemini/ }).click();
  await expect(page.locator('.rp-summary-text')).toHaveText('You spent 1 102.30 CHF. Groceries led at 34%.');
  const question = gemini.generateBodies.at(-1)?.contents?.[0]?.parts?.[0]?.text ?? '';
  expect(question).toContain('compared with August');
  expect(question).toMatch(/August: total 1\s150\.00; by category: Groceries 390\.00/);
  await shot(page, 'report-summary');

  const asked = gemini.generateBodies.length;
  await page.reload();
  await expect(page.locator('.rp-summary-text')).toHaveText('You spent 1 102.30 CHF. Groceries led at 34%.');
  expect(gemini.generateBodies.length).toBe(asked);
});
