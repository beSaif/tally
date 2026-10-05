/** Shared helpers for the E2E specs: page preparation, fixed clock, screenshots. */
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { MockApi } from './mock-api';
import { MockGemini } from './mock-gemini';
import { installFakePush } from './fake-push';

/** The design page's "now": Monday 5 October 2026, 20:14 in Geneva. */
export const FIXED_NOW = new Date('2026-10-05T20:14:00+02:00');
/** Looks like a Google AI Studio key; masked it reads "AIza••••••••••••••Qx4" like the design. */
export const TEST_KEY = 'AIzaSyD-tally-e2e-0123456789abcdefgQx4';
export const SCREENSHOT_DIR = 'e2e/__screenshots__';

export interface PrepareOptions {
  api?: MockApi;
  gemini?: MockGemini;
  /** Put a Gemini key in this device's storage before the app starts. */
  withKey?: boolean;
  /** Pin Date to FIXED_NOW (default true). */
  fixClock?: boolean;
}

export async function prepare(page: Page, opts: PrepareOptions = {}): Promise<{ api: MockApi | undefined; gemini: MockGemini }> {
  const gemini = opts.gemini ?? new MockGemini();
  await gemini.install(page);
  if (opts.api) await opts.api.install(page);
  await installFakePush(page);
  if (opts.fixClock ?? true) await page.clock.setFixedTime(FIXED_NOW);
  if (opts.withKey) {
    // Seed once per tab, so removing the key in the app is not undone by the next navigation.
    await page.addInitScript((key: string) => {
      try {
        if (sessionStorage.getItem('__seededKey')) return;
        sessionStorage.setItem('__seededKey', '1');
        localStorage.setItem('tally.gemini.key', key);
      } catch {
        /* about:blank */
      }
    }, TEST_KEY);
  }
  return { api: opts.api, gemini };
}

export async function shot(page: Page, name: string, opts: { fullPage?: boolean; animations?: 'disabled' | 'allow' } = {}): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: opts.fullPage ?? false, animations: opts.animations ?? 'disabled', caret: 'hide' });
}

/** Presses the mic like a finger: down, optionally move, then up after `holdMs`. */
export async function pressMic(page: Page, opts: { holdMs: number; dragUp?: number; release?: boolean }): Promise<void> {
  const mic = page.getByRole('button', { name: /Record a voice note|Enregistrer un message vocal/ });
  const box = await mic.boundingBox();
  if (!box) throw new Error('mic not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (opts.dragUp) await page.mouse.move(x, y - opts.dragUp, { steps: 4 });
  await page.waitForTimeout(opts.holdMs);
  if (opts.release ?? true) await page.mouse.up();
}
