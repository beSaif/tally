/**
 * Shared helpers for the E2E specs. The Worker API is real (wrangler dev on E2E_PORT); only Gemini
 * (mock-gemini.ts), Google's sign-in (fake-google.ts) and the browser's push service (fake-push.ts +
 * push-sink.ts) are stand-ins.
 */
import { mkdirSync } from 'node:fs';
import type { APIResponse, Page } from '@playwright/test';
import type { Entry, NewEntry, SettingsInput, User } from '../../src/shared/api';
import { MockGemini } from './mock-gemini';
import { installFakePush } from './fake-push';
import { fakeGoogle, type FakeGoogle } from './fake-google';

/** The design page's "now": Monday 5 October 2026, 20:14 in Geneva. */
export const FIXED_NOW = new Date('2026-10-05T20:14:00+02:00');
/** Looks like a Google AI Studio key; masked it reads "AIza••••••••••••••Qx4" like the design. */
export const TEST_KEY = 'AIzaSyD-tally-e2e-0123456789abcdefgQx4';
export const SCREENSHOT_DIR = 'e2e/__screenshots__';
/** Where fake subscriptions point when a test does not run a push sink (deliveries fail quietly). */
const NOWHERE = 'http://127.0.0.1:9/push/';

export interface PrepareOptions {
  gemini?: MockGemini;
  /** Put a Gemini key in this device's storage before the app starts. */
  withKey?: boolean;
  /** Pin Date to FIXED_NOW (default true). */
  fixClock?: boolean;
  /** Base URL of fake push endpoints (a PushSink). */
  pushEndpoint?: string;
}

export async function prepare(page: Page, opts: PrepareOptions = {}): Promise<{ gemini: MockGemini; google: FakeGoogle }> {
  const gemini = opts.gemini ?? new MockGemini();
  await gemini.install(page);
  // Whoever presses "Continue with Google" next is a brand-new account unless the test says otherwise.
  const google = await fakeGoogle();
  google.nextUser = { sub: uniqueSub(), email: uniqueEmail() };
  await installFakePush(page, opts.pushEndpoint ?? NOWHERE);
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
  return { gemini, google };
}

export function uniqueEmail(tag = 'lea'): string {
  return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** A Google account id nobody has signed in with (the local database outlives a test run). */
export function uniqueSub(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ok<T>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what}: HTTP ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

export interface Account {
  email: string;
  /** The Google account id; `google.nextUser = account` signs this account in again. */
  sub: string;
  user: User;
}

/**
 * Creates an account through the real sign-in flow, against the stand-in Google. `page.request`
 * follows the redirects and shares the browser context's cookies, so the page is signed in
 * afterwards. `settings` (e.g. `{ setup_complete: true }`) is applied too.
 */
export async function signUp(page: Page, opts: { email?: string; sub?: string; language?: 'en' | 'fr'; settings?: SettingsInput } = {}): Promise<Account> {
  const email = opts.email ?? uniqueEmail();
  const sub = opts.sub ?? uniqueSub();
  const google = await fakeGoogle();
  google.nextUser = { sub, email };
  // Follows the redirects out to the stand-in and back; the last response is the app shell for `/`.
  const landed = await page.request.get(`/api/auth/google/start?lang=${opts.language ?? 'en'}`);
  if (!landed.ok()) throw new Error(`sign-in: HTTP ${landed.status()} ${await landed.text()}`);
  const { user } = await ok<{ user: User }>(await page.request.get('/api/auth/me'), 'me after sign-in');
  if (user.email !== email) throw new Error(`signed in as ${user.email}, expected ${email}`);
  if (opts.settings) await ok(await page.request.put('/api/settings', { data: opts.settings }), 'settings');
  return { email, sub, user };
}

export async function seedEntries(page: Page, entries: readonly NewEntry[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; i += 50) {
    const res = await ok<{ entries: Entry[] }>(await page.request.post('/api/entries', { data: { entries: entries.slice(i, i + 50) } }), 'entries');
    out.push(...res.entries);
  }
  return out;
}

export async function listEntries(page: Page, from: string, to: string): Promise<Entry[]> {
  return (await ok<{ entries: Entry[] }>(await page.request.get(`/api/entries?from=${from}&to=${to}`), 'entries')).entries;
}

const entry = (occurred_at: string, amount: number, description: string, category: string | null, note: string | null = null, source: NewEntry['source'] = 'text'): NewEntry => ({
  amount_cents: Math.round(amount * 100),
  description,
  category,
  occurred_at,
  note,
  source,
});

/**
 * October 2026 adds up to the design (1 284.60 CHF; Groceries 412.30, Dining 286.10, Bills 240.00,
 * Transport 148.80, Fun 119.40, Shopping 78.00) with the A.1 rows on top; September is 1 102.30.
 */
export function designEntries(): NewEntry[] {
  return [
    // Mon 05 (today)
    entry('2026-10-05T18:05', 3.0, 'TPG ticket', 'Transport', null, 'voice'),
    entry('2026-10-05T12:40', 14.9, 'Migros lunch', 'Groceries'),
    entry('2026-10-05T09:12', 4.5, 'Coffee', 'Dining'),
    // Sun 04
    entry('2026-10-04T20:30', 19.5, 'Cinema, Pathé', 'Fun'),
    entry('2026-10-04T16:20', 11.4, 'Lake ferry', 'Transport'),
    entry('2026-10-04T12:15', 31.2, 'Brunch, Café du Marché', 'Dining'),
    entry('2026-10-04T10:05', 6.1, 'Bakery', 'Groceries'),
    // Sat 03
    entry('2026-10-03T21:10', 84.0, 'Dinner, Bains des Pâquis', 'Dining', 'Split with Léa · 168.00 total', 'voice'),
    entry('2026-10-03T19:30', 64.0, 'Concert, Victoria Hall', 'Fun'),
    entry('2026-10-03T16:45', 7.5, 'Ice cream', 'Dining'),
    entry('2026-10-03T15:20', 29.0, 'T-shirt', 'Shopping'),
    entry('2026-10-03T11:20', 96.4, 'Coop weekly shop', 'Groceries', null, 'photo'),
    entry('2026-10-03T10:30', 38.5, 'Farmers market', 'Groceries'),
    entry('2026-10-03T09:05', 22.8, 'Train → Lausanne', 'Transport', '½ fare'),
    entry('2026-10-03T08:40', 4.2, 'Coffee', 'Dining'),
    entry('2026-10-03T08:10', 3.0, 'TPG ticket', 'Transport'),
    // Fri 02
    entry('2026-10-02T19:00', 61.5, 'Manor food hall', 'Groceries'),
    entry('2026-10-02T18:10', 35.9, 'Books, Payot', 'Fun'),
    entry('2026-10-02T17:30', 19.0, 'Socks', 'Shopping'),
    entry('2026-10-02T12:30', 24.9, 'Lunch, Chez ma Cousine', 'Dining'),
    entry('2026-10-02T09:40', 52.8, 'Migros', 'Groceries'),
    entry('2026-10-02T08:55', 4.5, 'Coffee', 'Dining'),
    entry('2026-10-02T08:00', 70.0, 'TPG monthly pass', 'Transport'),
    entry('2026-10-02T07:30', 60.0, 'Internet', 'Bills'),
    // Thu 01
    entry('2026-10-01T20:45', 118.5, 'Team dinner', 'Dining'),
    entry('2026-10-01T18:20', 142.1, 'Coop big shop', 'Groceries'),
    entry('2026-10-01T17:15', 30.0, 'Notebook', 'Shopping'),
    entry('2026-10-01T13:10', 38.6, 'Taxi', 'Transport'),
    entry('2026-10-01T09:30', 6.8, 'Croissant & coffee', 'Dining'),
    entry('2026-10-01T08:00', 95.0, 'Electricity', 'Bills'),
    entry('2026-10-01T07:50', 45.0, 'Phone', 'Bills'),
    entry('2026-10-01T07:45', 40.0, 'Insurance top-up', 'Bills'),
    // September 2026: 1 102.30 (Dining 242.50, so October is +18%)
    entry('2026-09-28T19:40', 96.5, 'Dinner, Le Bologne', 'Dining'),
    entry('2026-09-27T11:00', 120.0, 'Coop weekly shop', 'Groceries'),
    entry('2026-09-25T08:00', 120.0, 'TPG + train', 'Transport'),
    entry('2026-09-22T12:15', 82.0, 'Lunches', 'Dining'),
    entry('2026-09-20T10:30', 160.0, 'Migros', 'Groceries'),
    entry('2026-09-18T20:00', 61.8, 'Cinema & drinks', 'Fun'),
    entry('2026-09-15T15:00', 58.0, 'Running shoes', 'Shopping'),
    entry('2026-09-12T09:00', 64.0, 'Coffee card', 'Dining'),
    entry('2026-09-10T18:30', 100.0, 'Farmers market', 'Groceries'),
    entry('2026-09-01T08:00', 240.0, 'Bills', 'Bills'),
  ];
}

/** A signed-in account with the design's numbers: budget 2 000, October 1 284.60, September 1 102.30. */
export async function designAccount(page: Page, opts: { language?: 'en' | 'fr' } = {}): Promise<Account> {
  const account = await signUp(page, { language: opts.language, settings: { setup_complete: true, budget_cents: 200_000 } });
  await seedEntries(page, designEntries());
  return account;
}

export async function shot(page: Page, name: string, opts: { fullPage?: boolean; animations?: 'disabled' | 'allow' } = {}): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: opts.fullPage ?? false, animations: opts.animations ?? 'disabled', caret: 'hide' });
}

/** Presses the mic like a finger: down, optionally drag up, then up after `holdMs` (unless `release: false`). */
export async function pressMic(page: Page, opts: { holdMs: number; release?: boolean }): Promise<void> {
  const mic = page.getByRole('button', { name: /Record a voice note|Enregistrer un message vocal/ });
  const box = await mic.boundingBox();
  if (!box) throw new Error('mic not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(opts.holdMs);
  if (opts.release ?? true) await page.mouse.up();
}

/** A receipt-like picture drawn in the page (PNG), for the camera input. */
export async function receiptPicture(page: Page): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 900;
    const g = c.getContext('2d');
    if (!g) return '';
    g.fillStyle = '#d9d4c7';
    g.fillRect(0, 0, 600, 900);
    g.fillStyle = '#fbfaf6';
    g.fillRect(90, 60, 420, 780);
    g.fillStyle = '#222';
    g.font = 'bold 34px monospace';
    g.fillText('COOP', 250, 140);
    g.font = '24px monospace';
    const lines = [['Bread', '4.20'], ['Fruit', '12.80'], ['Coffee beans', '18.90'], ['Cheese', '22.10'], ['Vegetables', '38.40']];
    lines.forEach(([name, amount], i) => {
      g.fillText(name ?? '', 120, 230 + i * 50);
      g.fillText(amount ?? '', 400, 230 + i * 50);
    });
    g.fillRect(120, 500, 360, 3);
    g.font = 'bold 28px monospace';
    g.fillText('TOTAL', 120, 560);
    g.fillText('96.40', 390, 560);
    return c.toDataURL('image/png');
  });
  return { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1] ?? '', 'base64') };
}
