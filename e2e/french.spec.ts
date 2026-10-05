/**
 * French UI (spec §4): switching the language in Settings, and "Auto" following a French device
 * from the first screen on. Real API; Gemini mocked.
 */
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_MODEL } from '../src/shared/constants';
import { designAccount, PASSWORD, prepare, shot, TEST_KEY, uniqueEmail } from './support/fixtures';

const NNBSP = ' ';

async function chooseFrench(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.getByLabel('Language').selectOption('fr');
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
}

test('switching to French in Settings translates every screen', async ({ page }) => {
  const { gemini } = await prepare(page, { withKey: true });
  await designAccount(page);
  await chooseFrench(page);
  await expect(page.getByLabel('Langue')).toHaveValue('fr');
  await expect(page.getByRole('heading', { name: 'Préférences' })).toBeVisible();
  await expect(page.getByText('Notifications sur cet appareil')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await shot(page, 'fr-settings', { fullPage: true });

  // Home: labels, dates and French typography (narrow no-break space before %).
  await page.getByRole('button', { name: '← Retour' }).click();
  await expect(page.getByRole('heading', { name: 'Dépensé ce mois-ci' })).toBeVisible();
  await expect(page.locator('.hero .meta-row span').first()).toHaveText(`64${NNBSP}% de 2${NNBSP}000`);
  await expect(page.getByText('26 jours restants')).toBeVisible();
  await expect(page.locator('.daygrp').nth(0)).toContainText('Aujourd’hui');
  await expect(page.locator('.daygrp').nth(1)).toContainText('Hier');
  await expect(page.locator('.daygrp').nth(2)).toContainText('sam. 03');
  await expect(page.getByRole('button', { name: 'Ouvrir l’aperçu' })).toHaveText('oct. 2026');
  await expect(page.getByLabel('Décrivez une dépense')).toHaveAttribute('placeholder', 'Café 4.50 — ou dites-le');
  await shot(page, 'fr-home');

  // Capture: the sheet is French and Gemini is told the person's language.
  await page.getByLabel('Décrivez une dépense').fill('café 3.80');
  await page.getByLabel('Décrivez une dépense').press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Nouvelle dépense' });
  await expect(sheet.getByText('Lu par Gemini')).toBeVisible();
  await expect(sheet.getByText('Montant')).toBeVisible();
  await expect(sheet.getByText('Aujourd’hui, 20:14')).toBeVisible();
  await shot(page, 'fr-capture-result');
  expect(gemini.generateBodies.at(-1)?.systemInstruction?.parts?.[0]?.text).toContain("The person's language: French.");
  await sheet.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.entries li.fresh')).toContainText('Café');
  await expect(page.locator('.entries li.fresh')).toContainText('3.80');

  // Batch wording.
  await page.getByLabel('Décrivez une dépense').fill('groceries 23.40 at coop, a coffee for 4 and the train to Lausanne 22.80 half fare');
  await page.getByLabel('Décrivez une dépense').press('Enter');
  await expect(sheet.getByText('3 dépenses trouvées')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Noter 3 dépenses' })).toBeVisible();
  await shot(page, 'fr-capture-batch');
  await page.keyboard.press('Escape');
  await page.getByLabel('Décrivez une dépense').fill('');

  // Overview.
  await page.getByRole('button', { name: 'Ouvrir l’aperçu' }).click();
  await expect(page.getByRole('heading', { name: 'octobre 2026' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Semaine' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Mois' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.stats')).toHaveText('33 dépenses · moy. 257.68 / jour');
  await expect(page.getByRole('link', { name: 'Exporter en CSV →' })).toBeVisible();
  await expect(page.getByLabel('Interroger vos dépenses')).toHaveAttribute('placeholder', `Demandez${NNBSP}: «${NNBSP}combien en café ce mois-ci${NNBSP}?${NNBSP}»`);
  await page.getByLabel('Interroger vos dépenses').fill('Combien ce mois-ci ?');
  await page.getByRole('button', { name: 'Demander' }).click();
  await expect(page.locator('.answer')).toContainText('Vous avez dépensé 1');
  await expect(page.locator('.answer .acc')).toHaveText('Groceries');
  await page.getByRole('tab', { name: 'Semaine' }).click();
  await expect(page.getByRole('heading', { name: 'Semaine 41 · 5–11 oct.' })).toBeVisible();
  await shot(page, 'fr-overview-week');
  await page.getByRole('tab', { name: 'Mois' }).click();
  await shot(page, 'fr-overview', { fullPage: true });
});

test.describe('a French device', () => {
  test.use({ locale: 'fr-CH' });

  test('signs up and sets up in French, with French default categories', async ({ page }) => {
    await prepare(page);
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /Créez votre/ })).toBeVisible();
    await shot(page, 'fr-signup');
    await page.getByLabel('E-mail').fill(uniqueEmail('fr'));
    await page.getByLabel('Mot de passe').fill('court');
    await page.getByRole('button', { name: 'Créer le compte' }).click();
    await expect(page.getByRole('alert')).toHaveText('Vérifiez l’e-mail et utilisez au moins 8 caractères pour le mot de passe.');
    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Créer le compte' }).click();

    await expect(page.getByRole('heading', { name: /Apportez/ })).toBeVisible();
    await expect(page.getByText('Étape 01 / 02')).toBeVisible();
    await page.getByLabel('Clé API Google AI Studio').fill(TEST_KEY);
    await expect(page.getByText(`La clé fonctionne · ${DEFAULT_MODEL}`)).toBeVisible();
    await shot(page, 'fr-setup-key');
    await page.getByRole('button', { name: 'Continuer' }).click();

    await expect(page.getByRole('heading', { name: /Quelques/ })).toBeVisible();
    await expect(page.getByLabel('Devise')).toHaveValue('CHF');
    await expect(page.getByLabel('Langue')).toHaveValue('auto');
    for (const name of ['Courses', 'Restaurants', 'Transport', 'Maison', 'Santé', 'Loisirs', 'Shopping', 'Factures']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    await shot(page, 'fr-setup-defaults');
    await page.getByRole('button', { name: 'Commencer' }).click();
    await expect(page.getByText('Rien de noté pour l’instant. Tapez une ligne ou touchez le micro.')).toBeVisible();
    await shot(page, 'fr-home-empty');
  });
});
