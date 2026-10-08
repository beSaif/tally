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
  await expect(page.locator('.bars li').first()).toHaveText(/Groceries\s*\+9%\s*32%\s*412\.30/);
  await shot(page, 'analytics-month');

  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Ledger' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');

  // The phone's back button does the same as the Ledger tab.
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(/\/overview$/);
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
  await expect(sheet.locator('.entries li').first()).toHaveText(/TPG ticket\s*Transport\s*3\.00/);
  await shot(page, 'analytics-category');

  // An entry opens for editing; moving it to another category updates the bars.
  await sheet.locator('.entries li', { hasText: 'Taxi' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit entry' });
  await edit.getByRole('radio', { name: 'Fun' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
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
  await expect(page.locator('.rp-vs')).toHaveText('−4% vs August (−47.70)');
  await expect(page.locator('.rp-stats dd')).toHaveText(['10', '36.74', /Tue 01\s*240\.00/]);
  await expect(page.locator('.bars li').first()).toHaveText(/Groceries\s*−3%\s*34%\s*380\.00/);
  await expect(page.locator('.rp-biggest li')).toHaveCount(5);
  await expect(page.locator('.rp-biggest li').first()).toHaveText(/1 Sept\s*Bills\s*Bills\s*240\.00/);
  await expect(page.locator('.cols li.on .m')).toHaveText('Sept');
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
