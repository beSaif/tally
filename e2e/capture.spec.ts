/**
 * The capture sheet (spec §3.4–3.5, design A.2 + C.2) in every state, against the real API:
 * voice (hold, tap, slide to cancel), text, batch, photo, edit mode, nothing parsed, errors, and the
 * entry sheet (§3.7). Screenshots of each state go to e2e/__screenshots__/capture-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { designAccount, listEntries, prepare, pressMic, receiptPicture, shot } from './support/fixtures';
import { BATCH_TEXT, VOICE_TRANSCRIPT, type MockGemini } from './support/mock-gemini';

const composer = (page: Page) => page.getByLabel('Describe an expense');
const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'New expense' });

async function logText(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

async function home(page: Page): Promise<{ gemini: MockGemini }> {
  const { gemini } = await prepare(page, { withKey: true });
  await designAccount(page);
  await page.goto('/');
  await expect(page.locator('.hero-num')).toHaveText('1 284.60');
  return { gemini };
}

const micBox = async (page: Page) => {
  const box = await page.getByRole('button', { name: 'Record a voice note' }).boundingBox();
  if (!box) throw new Error('mic not visible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('voice: hold to talk, release to send, then confirm (A.2)', async ({ page }) => {
  const { gemini } = await home(page);
  const sheet = sheetOf(page);
  await pressMic(page, { holdMs: 1300, release: false });
  await expect(sheet.getByText('Release to send')).toBeVisible();
  await expect(sheet.getByText(/Listening · 0:0[1-9]/)).toBeVisible();
  await expect(sheet.locator('.wave b')).toHaveCount(46);
  await shot(page, 'capture-01-recording-hold');

  // Slide up past 80px: release would cancel. Come back down: it sends again.
  const { x, y } = await micBox(page);
  await page.mouse.move(x, y - 120, { steps: 5 });
  await expect(sheet.getByText('Release to cancel')).toBeVisible();
  await shot(page, 'capture-02-recording-cancel-armed');
  await page.mouse.move(x, y, { steps: 5 });
  await expect(sheet.getByText('Release to send')).toBeVisible();

  gemini.hold();
  await page.mouse.up();
  await expect(sheet.getByText('Gemini is listening…')).toBeVisible();
  await expect(sheet.locator('.skeleton')).toBeVisible();
  await shot(page, 'capture-04-thinking-voice');
  gemini.release();

  await expect(sheet.getByText('Gemini parsed')).toBeVisible();
  await expect(sheet.locator('.quote')).toHaveText(`“${VOICE_TRANSCRIPT}”`);
  await expect(sheet.locator('.kv .amount')).toHaveText('21.00 CHF');
  await expect(sheet.getByText('Dinner, Bains des Pâquis')).toBeVisible();
  await expect(sheet.getByText('Today, 20:14')).toBeVisible();
  await expect(sheet.getByText('Split with Léa · 42.00 total')).toBeVisible();
  await shot(page, 'capture-05-voice-result');
  const audio = gemini.generateBodies.at(-1)?.contents?.[0]?.parts?.[0]?.inlineData;
  expect(audio?.mimeType).toBe('audio/wav');
  expect(Buffer.from(audio?.data ?? '', 'base64').subarray(0, 4).toString()).toBe('RIFF');

  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(sheet.getByLabel('Amount')).toHaveValue('21.00');
  await shot(page, 'capture-06-voice-edit');
  await sheet.getByLabel('Amount').fill('21,50');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  const saved = (await listEntries(page, '2026-10-05', '2026-10-05')).find((e) => e.source === 'voice' && e.description.startsWith('Dinner'));
  expect(saved).toMatchObject({ amount_cents: 2150, category_name: 'Dining', note: 'Split with Léa · 42.00 total', occurred_at: '2026-10-05T20:14' });
  await expect(page.locator('.entries li.fresh')).toContainText('21.50');
});

test('voice: a quick tap keeps listening until Stop & send; sliding up cancels', async ({ page }) => {
  const { gemini } = await home(page);
  const sheet = sheetOf(page);
  await pressMic(page, { holdMs: 80 });
  await expect(sheet.getByText('Tap to stop')).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, 'capture-03-recording-tap');
  await sheet.getByRole('button', { name: 'Stop & send' }).click();
  await expect(sheet.getByText('Gemini parsed')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Hold, slide up, release: nothing is sent.
  const before = gemini.generateCalls;
  await pressMic(page, { holdMs: 700, dragUp: 120 });
  await expect(sheet).toBeHidden();
  expect(gemini.generateCalls).toBe(before);
});

test('text: thinking, one entry, edit and cancel, save; Escape and the focus trap', async ({ page }) => {
  const { gemini } = await home(page);
  const sheet = sheetOf(page);
  gemini.hold();
  await logText(page, 'Dinner at Bains des Pâquis with Léa, 42 francs, we split it');
  await expect(sheet.getByText('Gemini is reading…')).toBeVisible();
  await shot(page, 'capture-07-thinking-text');
  // × cancels the request; the typed text stays in the composer.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  gemini.release();
  await expect(composer(page)).toHaveValue('Dinner at Bains des Pâquis with Léa, 42 francs, we split it');

  await composer(page).press('Enter');
  await expect(sheet.getByText('Gemini parsed')).toBeVisible();
  await expect(sheet.getByText('You wrote')).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  await shot(page, 'capture-08-text-single');

  // Focus stays in the sheet.
  await expect(sheet).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // Edit, change things, Cancel: the parsed values come back.
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  await sheet.getByLabel('Amount').fill('99');
  await sheet.getByRole('radio', { name: 'Fun' }).click();
  await shot(page, 'capture-09-text-edit');
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sheet.locator('.kv .amount')).toHaveText('21.00 CHF');
  await expect(sheet.getByText('Dining', { exact: true })).toBeVisible();

  // Escape closes without saving and gives the text back.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(composer(page)).toHaveValue('Dinner at Bains des Pâquis with Léa, 42 francs, we split it');
  await composer(page).press('Enter');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(composer(page)).toHaveValue('');
  await expect(page.locator('.hero-num')).toHaveText('1 305.60');
});

test('batch: three entries, untick one, edit all, log two (C.2)', async ({ page }) => {
  await home(page);
  const sheet = sheetOf(page);
  await logText(page, BATCH_TEXT);
  await expect(sheet.getByText('3 entries found')).toBeVisible();
  await expect(sheet.getByRole('checkbox')).toHaveCount(3);
  await expect(sheet.locator('.total')).toHaveText('50.20 CHF');
  await shot(page, 'capture-10-batch');
  await sheet.getByRole('checkbox', { name: 'Include Coffee' }).click();
  await expect(sheet.locator('.total')).toHaveText('46.20 CHF');
  await expect(sheet.getByRole('button', { name: 'Log 2 entries' })).toBeVisible();
  await shot(page, 'capture-11-batch-unticked');

  // Tapping a row's text opens just that row for editing.
  await sheet.getByRole('button', { name: 'Edit Coop' }).click();
  await expect(sheet.locator('.feed-edit')).toHaveCount(1);
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(sheet.locator('.feed-edit')).toHaveCount(3);
  await sheet.locator('.feed-edit').first().getByLabel('What').fill('Coop Plainpalais');
  await sheet.locator('.feed-edit').first().getByLabel('Amount').fill('23.90');
  await expect(sheet.locator('.total')).toHaveText('46.70 CHF');
  await shot(page, 'capture-12-batch-edit');
  await sheet.getByRole('button', { name: 'Log 2 entries' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.entries li.fresh')).toHaveCount(2);
  const today = await listEntries(page, '2026-10-05', '2026-10-05');
  expect(today.find((e) => e.description === 'Coop Plainpalais')).toMatchObject({ amount_cents: 2390, category_name: 'Groceries' });
  expect(today.find((e) => e.description === 'Train → Lausanne')).toMatchObject({ amount_cents: 2280, note: '½ fare' });
  expect(today.some((e) => e.description === 'Coffee' && e.occurred_at === '2026-10-05T20:14')).toBe(false);
});

test('photo: a receipt picture, thumbnail while reading, then save', async ({ page }) => {
  const { gemini } = await home(page);
  const sheet = sheetOf(page);
  gemini.hold();
  await page.locator('input[type=file]').setInputFiles(await receiptPicture(page));
  await expect(sheet.getByText('Gemini is reading…')).toBeVisible();
  await expect(sheet.locator('img.thumb')).toBeVisible();
  await shot(page, 'capture-13-thinking-photo');
  gemini.release();
  await expect(sheet.getByText('Coop weekly shop')).toBeVisible();
  await shot(page, 'capture-14-photo-result');
  const image = gemini.generateBodies.at(-1)?.contents?.[0]?.parts?.[0]?.inlineData;
  expect(image?.mimeType).toBe('image/jpeg');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  const saved = (await listEntries(page, '2026-10-05', '2026-10-05')).find((e) => e.source === 'photo');
  expect(saved).toMatchObject({ amount_cents: 9640, description: 'Coop weekly shop', note: 'Bread, fruit, coffee beans' });
});

test('nothing parsed: Type it puts the text back in the composer', async ({ page }) => {
  await home(page);
  const sheet = sheetOf(page);
  await logText(page, 'lunch with Léa');
  await expect(sheet.getByText('I could not find an amount in that.')).toBeVisible();
  await shot(page, 'capture-15-nothing-parsed');
  await sheet.getByRole('button', { name: 'Type it' }).click();
  await expect(sheet).toBeHidden();
  await expect(composer(page)).toHaveValue('lunch with Léa');
  await expect(composer(page)).toBeFocused();
});

test('errors: quota, rejected key, no connection, unreadable answer, offline save, microphone', async ({ page, context }) => {
  const { gemini } = await home(page);
  const sheet = sheetOf(page);

  gemini.failNext(429, 'Resource has been exhausted (e.g. check quota).');
  await logText(page, 'coffee 4');
  await expect(sheet.getByRole('alert')).toHaveText("Gemini's free tier is out of requests for now. Try again in a minute.");
  await shot(page, 'capture-16-error-quota');
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet.getByText('Gemini parsed')).toBeVisible();
  await page.keyboard.press('Escape');

  gemini.dropNext();
  await composer(page).press('Enter');
  await expect(sheet.getByRole('alert')).toHaveText('No connection to Gemini.');
  await shot(page, 'capture-17-error-network');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(composer(page)).toHaveValue('coffee 4');

  gemini.answerNext('Sorry, I cannot help with that.');
  await composer(page).press('Enter');
  await expect(sheet.getByRole('alert')).toHaveText('Gemini answered something I could not read.');
  await sheet.getByRole('button', { name: 'Close' }).click();

  // Saving while offline keeps the sheet open with the error line.
  await composer(page).press('Enter');
  await expect(sheet.getByText('Gemini parsed')).toBeVisible();
  await context.setOffline(true);
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Could not save. Try again.');
  await expect(page.locator('.toast')).toHaveText("You're offline.");
  await shot(page, 'capture-18-save-offline');
  await context.setOffline(false);
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();

  gemini.failNext(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID');
  await logText(page, 'coffee 4');
  await expect(sheet.getByRole('alert')).toHaveText('Gemini rejected your key. Check it in Settings.');
  await shot(page, 'capture-19-error-key');
  await sheet.getByRole('link', { name: 'Open Settings →' }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test.describe('without microphone permission', () => {
  test('explains how to allow it', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await home(page);
    await pressMic(page, { holdMs: 100 });
    await expect(sheetOf(page).getByRole('alert')).toHaveText('Tally needs the microphone. Allow it in your browser settings.');
    await shot(page, 'capture-20-error-mic');
  });
});

test('entry sheet: edit, delete with confirm, undo (§3.7)', async ({ page }) => {
  await home(page);
  const row = page.locator('.entries li', { hasText: 'Migros lunch' });
  await row.click();
  const sheet = page.getByRole('dialog', { name: 'Edit entry' });
  await expect(sheet.getByLabel('Amount')).toHaveValue('14.90');
  await expect(sheet.getByRole('radio', { name: 'Groceries' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByLabel('When')).toHaveValue('2026-10-05T12:40');
  await shot(page, 'entry-01-edit');
  await sheet.getByLabel('Amount').fill('16.40');
  await sheet.getByLabel('What').fill('Migros lunch, two');
  await sheet.getByRole('radio', { name: 'Other' }).click();
  await sheet.getByLabel('When').fill('2026-10-04T12:40');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  const moved = page.locator('.entries li', { hasText: 'Migros lunch, two' });
  await expect(moved).toContainText('Other');
  await expect(moved).toContainText('16.40');
  // It moved to yesterday's group.
  await expect(page.locator('section.day').nth(1)).toContainText('Migros lunch, two');
  const [edited] = (await listEntries(page, '2026-10-04', '2026-10-04')).filter((e) => e.description === 'Migros lunch, two');
  expect(edited).toMatchObject({ amount_cents: 1640, category_id: null, occurred_at: '2026-10-04T12:40' });

  await moved.click();
  await sheet.getByRole('button', { name: 'Delete entry' }).click();
  await expect(sheet.getByText('Delete this entry?')).toBeVisible();
  await shot(page, 'entry-02-delete-confirm');
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sheet.getByLabel('Amount')).toBeVisible();
  await sheet.getByRole('button', { name: 'Delete entry' }).click();
  await sheet.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(moved).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Entry deleted');
  await shot(page, 'entry-03-undo-toast');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(moved).toContainText('16.40');
});
