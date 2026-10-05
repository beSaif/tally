/**
 * In-memory implementation of the Worker API contract (docs/SPEC.md §6), installed with
 * `page.route('**\/api/**')`. Lets the UI be driven and screenshotted without the Worker routes.
 */
import type { Page, Route } from '@playwright/test';
import type {
  Bootstrap,
  Category,
  Entry,
  EntrySource,
  NewEntry,
  PushSubscriptionRow,
  Settings,
  Summary,
  SummaryCategory,
  User,
} from '../../src/shared/api';
import { DEFAULT_CATEGORIES } from '../../src/shared/constants';

export interface MockApiOptions {
  /** Start with a session (and an account). */
  loggedIn?: boolean;
  /** `settings.setup_complete`. */
  setupComplete?: boolean;
  /** 'design' fills Sept + Oct 2026 with the design page's numbers. */
  seed?: 'design' | 'empty';
  /** Language of the account's default categories. */
  language?: 'en' | 'fr';
  settings?: Partial<Omit<Settings, 'notifications'>> & { notifications?: Partial<Settings['notifications']> };
  /** When set, sign-up needs this invite code (403 invite_required otherwise). */
  inviteCode?: string;
  email?: string;
  password?: string;
  /** Existing push devices (other than this browser). */
  devices?: Array<{ user_agent: string; lang?: 'en' | 'fr' }>;
}

interface StoredEntry extends Entry {
  raw_input: string | null;
}
interface StoredSub extends PushSubscriptionRow {
  keys: { p256dh: string; auth: string };
}

export interface ApiCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string, message = code) => json(route, status, { error: { code, message } });

const uuid = () => crypto.randomUUID();
const ms = (iso: string) => new Date(iso).getTime();

/** The VAPID public key used by the Worker tests (any valid P-256 point works for the fake PushManager). */
export const MOCK_VAPID_KEY = 'BJ9P9iXcAieB62riJYMOiKskybW6xbYDMAuZHYraWeVXyTEQggXq1Do7ULYJRsUKv16InFII5M_TxYb05974iGI';

export class MockApi {
  readonly calls: ApiCall[] = [];
  user: (User & { password: string }) | null = null;
  loggedIn: boolean;
  settings: Settings;
  categories: Category[] = [];
  entries: StoredEntry[] = [];
  subscriptions: StoredSub[] = [];
  skips: string[] = [];
  /** When true every request fails like a dropped connection. */
  offline = false;
  private failures: Array<{ method: string; path: RegExp; status: number; code: string }> = [];
  private readonly inviteCode: string | undefined;

  constructor(opts: MockApiOptions = {}) {
    this.inviteCode = opts.inviteCode;
    this.loggedIn = Boolean(opts.loggedIn);
    const language = opts.language ?? 'en';
    this.settings = {
      currency: 'CHF',
      language: 'auto',
      budget_cents: null,
      model: 'gemini-2.5-flash',
      setup_complete: Boolean(opts.setupComplete),
      updated_at: ms('2026-08-15T10:00:00Z'),
      ...opts.settings,
      notifications: {
        reminder: false,
        reminder_time: '20:30',
        reminder_only_if_empty: true,
        budget: true,
        weekly: true,
        monthly: true,
        ...opts.settings?.notifications,
      },
    };
    if (opts.loggedIn) {
      this.user = { id: uuid(), email: opts.email ?? 'lea@example.com', password: opts.password ?? 'correct horse', created_at: ms('2026-08-15T10:00:00Z') };
      this.categories = DEFAULT_CATEGORIES[language].map((name, position) => ({ id: uuid(), name, position }));
    }
    if (opts.seed === 'design') this.seedDesign();
    for (const d of opts.devices ?? []) {
      this.subscriptions.push({
        id: uuid(),
        endpoint: `https://fcm.googleapis.com/fcm/send/${uuid()}`,
        user_agent: d.user_agent,
        lang: d.lang ?? 'en',
        tz: 'Europe/Zurich',
        created_at: ms('2026-09-20T08:00:00Z'),
        last_seen_at: ms('2026-10-04T18:00:00Z'),
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
      });
    }
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/**', (route) => this.handle(route));
  }

  /** Makes the next matching request fail with this status/code. */
  failNext(method: string, path: RegExp, status: number, code: string): void {
    this.failures.push({ method, path, status, code });
  }

  bootstrap(): Bootstrap {
    if (!this.user) throw new Error('no user');
    const { password: _password, ...user } = this.user;
    return { user, settings: this.settings, categories: this.categories };
  }

  // ------------------------------------------------------------------ seed

  /** October 2026 adds up to the design (1 284.60 CHF; Groceries 412.30 … Shopping 78.00). */
  private seedDesign(): void {
    const cat = (name: string) => this.categories.find((c) => c.name === name) ?? null;
    const add = (at: string, amount: number, description: string, category: string | null, note: string | null = null, source: EntrySource = 'text') => {
      const c = category ? cat(category) : null;
      const created = ms(`${at}:00+02:00`);
      this.entries.push({
        id: uuid(),
        amount_cents: Math.round(amount * 100),
        currency: 'CHF',
        description,
        category_id: c?.id ?? null,
        category_name: c?.name ?? null,
        occurred_at: at,
        note,
        source,
        created_at: created,
        updated_at: created,
        raw_input: null,
      });
    };
    this.settings.budget_cents = this.settings.budget_cents ?? 200000;
    // Mon 05 (today in the visual tests)
    add('2026-10-05T18:05', 3.0, 'TPG ticket', 'Transport', null, 'voice');
    add('2026-10-05T12:40', 14.9, 'Migros lunch', 'Groceries');
    add('2026-10-05T09:12', 4.5, 'Coffee', 'Dining');
    // Sun 04
    add('2026-10-04T20:30', 19.5, 'Cinema, Pathé', 'Fun');
    add('2026-10-04T16:20', 11.4, 'Lake ferry', 'Transport');
    add('2026-10-04T12:15', 31.2, 'Brunch, Café du Marché', 'Dining');
    add('2026-10-04T10:05', 6.1, 'Bakery', 'Groceries');
    // Sat 03
    add('2026-10-03T21:10', 84.0, 'Dinner, Bains des Pâquis', 'Dining', 'Split with Léa · 168.00 total', 'voice');
    add('2026-10-03T19:30', 64.0, 'Concert, Victoria Hall', 'Fun');
    add('2026-10-03T16:45', 7.5, 'Ice cream', 'Dining');
    add('2026-10-03T15:20', 29.0, 'T-shirt', 'Shopping');
    add('2026-10-03T11:20', 96.4, 'Coop weekly shop', 'Groceries', null, 'photo');
    add('2026-10-03T10:30', 38.5, 'Farmers market', 'Groceries');
    add('2026-10-03T09:05', 22.8, 'Train → Lausanne', 'Transport', '½ fare');
    add('2026-10-03T08:40', 4.2, 'Coffee', 'Dining');
    add('2026-10-03T08:10', 3.0, 'TPG ticket', 'Transport');
    // Fri 02
    add('2026-10-02T19:00', 61.5, 'Manor food hall', 'Groceries');
    add('2026-10-02T18:10', 35.9, 'Books, Payot', 'Fun');
    add('2026-10-02T17:30', 19.0, 'Socks', 'Shopping');
    add('2026-10-02T12:30', 24.9, 'Lunch, Chez ma Cousine', 'Dining');
    add('2026-10-02T09:40', 52.8, 'Migros', 'Groceries');
    add('2026-10-02T08:55', 4.5, 'Coffee', 'Dining');
    add('2026-10-02T08:00', 70.0, 'TPG monthly pass', 'Transport');
    add('2026-10-02T07:30', 60.0, 'Internet', 'Bills');
    // Thu 01
    add('2026-10-01T20:45', 118.5, 'Team dinner', 'Dining');
    add('2026-10-01T18:20', 142.1, 'Coop big shop', 'Groceries');
    add('2026-10-01T17:15', 30.0, 'Notebook', 'Shopping');
    add('2026-10-01T13:10', 38.6, 'Taxi', 'Transport');
    add('2026-10-01T09:30', 6.8, 'Croissant & coffee', 'Dining');
    add('2026-10-01T08:00', 95.0, 'Electricity', 'Bills');
    add('2026-10-01T07:50', 45.0, 'Phone', 'Bills');
    add('2026-10-01T07:45', 40.0, 'Insurance top-up', 'Bills');
    // September 2026: 1 102.30 (Dining 242.50 → October is +18%)
    add('2026-09-28T19:40', 96.5, 'Dinner, Le Bologne', 'Dining');
    add('2026-09-27T11:00', 120.0, 'Coop weekly shop', 'Groceries');
    add('2026-09-25T08:00', 120.0, 'TPG + train', 'Transport');
    add('2026-09-22T12:15', 82.0, 'Lunches', 'Dining');
    add('2026-09-20T10:30', 160.0, 'Migros', 'Groceries');
    add('2026-09-18T20:00', 61.8, 'Cinema & drinks', 'Fun');
    add('2026-09-15T15:00', 58.0, 'Running shoes', 'Shopping');
    add('2026-09-12T09:00', 64.0, 'Coffee card', 'Dining');
    add('2026-09-10T18:30', 100.0, 'Farmers market', 'Groceries');
    add('2026-09-01T08:00', 240.0, 'Bills', 'Bills');
  }

  // ------------------------------------------------------------------ routing

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method().toUpperCase();
    const path = url.pathname.replace(/^\/api/, '') || '/';
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    const query = Object.fromEntries(url.searchParams.entries());
    this.calls.push({ method, path, query, body });

    if (this.offline) return route.abort('internetdisconnected');
    const forced = this.failures.findIndex((f) => f.method === method && f.path.test(path));
    if (forced >= 0) {
      const [f] = this.failures.splice(forced, 1);
      return fail(route, f!.status, f!.code);
    }

    if (path === '/health') return json(route, 200, { ok: true, name: 'tally' });
    if (path.startsWith('/auth/')) return this.auth(route, method, path, body as Record<string, string> | null);
    if (!this.loggedIn || !this.user) return fail(route, 401, 'unauthorized', 'Not signed in');

    if (path === '/settings') return this.settingsRoute(route, method, body as Record<string, unknown> | null);
    if (path === '/categories') return this.categoriesRoute(route, method, body as { categories?: Array<{ id?: string; name: string }> } | null);
    if (path === '/entries' || path.startsWith('/entries/')) return this.entriesRoute(route, method, path, query, body);
    if (path === '/summary' && method === 'GET') return json(route, 200, this.summary(query));
    if (path === '/export.csv' && method === 'GET') return this.exportCsv(route, query);
    if (path.startsWith('/push/')) return this.pushRoute(route, method, path, body as Record<string, unknown> | null);
    return fail(route, 404, 'not_found', 'No such endpoint');
  }

  private async auth(route: Route, method: string, path: string, body: Record<string, string> | null): Promise<void> {
    if (path === '/auth/me' && method === 'GET') {
      return this.loggedIn && this.user ? json(route, 200, this.bootstrap()) : fail(route, 401, 'unauthorized');
    }
    if (path === '/auth/signup' && method === 'POST') {
      const email = String(body?.email ?? '').trim().toLowerCase();
      const password = String(body?.password ?? '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return fail(route, 400, 'validation', 'password: Too small');
      if (this.inviteCode && body?.invite_code !== this.inviteCode) return fail(route, 403, 'invite_required');
      if (this.user && this.user.email === email) return fail(route, 409, 'email_taken');
      const language = body?.language === 'fr' ? 'fr' : 'en';
      this.user = { id: uuid(), email, password, created_at: Date.now() };
      this.categories = DEFAULT_CATEGORIES[language].map((name, position) => ({ id: uuid(), name, position }));
      this.settings.setup_complete = false;
      this.loggedIn = true;
      const { password: _p, ...user } = this.user;
      return json(route, 201, { user });
    }
    if (path === '/auth/login' && method === 'POST') {
      const email = String(body?.email ?? '').trim().toLowerCase();
      if (!this.user || this.user.email !== email || this.user.password !== body?.password) return fail(route, 401, 'invalid_credentials');
      this.loggedIn = true;
      const { password: _p, ...user } = this.user;
      return json(route, 200, { user });
    }
    if (path === '/auth/logout' && method === 'POST') {
      this.loggedIn = false;
      return route.fulfill({ status: 204 });
    }
    if (!this.loggedIn || !this.user) return fail(route, 401, 'unauthorized');
    if (path === '/auth/password' && method === 'POST') {
      if (body?.current !== this.user.password) return fail(route, 401, 'invalid_credentials');
      if (String(body?.new ?? '').length < 8) return fail(route, 400, 'validation');
      this.user.password = String(body?.new);
      return route.fulfill({ status: 204 });
    }
    if (path === '/auth/account' && method === 'DELETE') {
      if (body?.password !== this.user.password) return fail(route, 401, 'invalid_credentials');
      this.user = null;
      this.loggedIn = false;
      this.entries = [];
      this.subscriptions = [];
      return route.fulfill({ status: 204 });
    }
    return fail(route, 404, 'not_found');
  }

  private settingsRoute(route: Route, method: string, body: Record<string, unknown> | null): Promise<void> {
    if (method === 'GET') return json(route, 200, { settings: this.settings });
    if (method !== 'PUT' || !body) return fail(route, 400, 'validation');
    const { notifications, ...rest } = body as Partial<Settings> & { notifications?: Partial<Settings['notifications']> };
    if (rest.currency !== undefined && !/^[A-Z]{3}$/.test(rest.currency)) return fail(route, 400, 'validation', 'currency');
    if (notifications?.reminder_time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(notifications.reminder_time)) return fail(route, 400, 'validation', 'reminder_time');
    this.settings = { ...this.settings, ...rest, notifications: { ...this.settings.notifications, ...notifications }, updated_at: Date.now() };
    return json(route, 200, { settings: this.settings });
  }

  private categoriesRoute(route: Route, method: string, body: { categories?: Array<{ id?: string; name: string }> } | null): Promise<void> {
    if (method === 'GET') return json(route, 200, { categories: this.categories });
    if (method !== 'PUT' || !body?.categories) return fail(route, 400, 'validation');
    const seen = new Set<string>();
    const next: Category[] = [];
    for (const [position, c] of body.categories.entries()) {
      const name = c.name.trim();
      if (!name || name.length > 40 || seen.has(name.toLowerCase())) return fail(route, 400, 'validation', 'categories');
      seen.add(name.toLowerCase());
      const existing = c.id ? this.categories.find((x) => x.id === c.id) : undefined;
      next.push({ id: existing?.id ?? uuid(), name, position });
    }
    const kept = new Set(next.map((c) => c.id));
    for (const e of this.entries) {
      if (e.category_id && !kept.has(e.category_id)) {
        e.category_id = null;
        e.category_name = null;
      } else if (e.category_id) {
        e.category_name = next.find((c) => c.id === e.category_id)?.name ?? null;
      }
    }
    this.categories = next;
    return json(route, 200, { categories: this.categories });
  }

  private resolveCategory(input: { category_id?: string | null; category?: string | null }): Category | null {
    if (input.category_id !== undefined) return input.category_id ? this.categories.find((c) => c.id === input.category_id) ?? null : null;
    if (input.category) return this.categories.find((c) => c.name.toLowerCase() === input.category!.trim().toLowerCase()) ?? null;
    return null;
  }

  private toEntry(e: StoredEntry): Entry {
    const { raw_input: _raw, ...entry } = e;
    return entry;
  }

  private entriesRoute(route: Route, method: string, path: string, query: Record<string, string>, body: unknown): Promise<void> {
    const sorted = () => [...this.entries].sort((a, b) => (a.occurred_at === b.occurred_at ? b.created_at - a.created_at : a.occurred_at < b.occurred_at ? 1 : -1));
    if (path === '/entries' && method === 'GET') {
      const from = query.from ?? '0000-00-00';
      const to = query.to ?? '9999-99-99';
      const list = sorted().filter((e) => e.occurred_at.slice(0, 10) >= from && e.occurred_at.slice(0, 10) <= to);
      return json(route, 200, { entries: list.map((e) => this.toEntry(e)) });
    }
    if (path === '/entries' && method === 'POST') {
      const list = (body as { entries?: NewEntry[] } | null)?.entries;
      if (!Array.isArray(list) || list.length === 0 || list.length > 50) return fail(route, 400, 'validation', 'entries');
      const created: StoredEntry[] = [];
      for (const n of list) {
        if (!Number.isInteger(n.amount_cents) || n.amount_cents < 0 || !n.description?.trim() || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(n.occurred_at)) {
          return fail(route, 400, 'validation', 'entries.0');
        }
        const c = this.resolveCategory(n);
        const now = Date.now() + created.length;
        created.push({
          id: uuid(),
          amount_cents: n.amount_cents,
          currency: n.currency ?? this.settings.currency,
          description: n.description.trim(),
          category_id: c?.id ?? null,
          category_name: c?.name ?? null,
          occurred_at: n.occurred_at,
          note: n.note ?? null,
          source: n.source,
          created_at: now,
          updated_at: now,
          raw_input: n.raw_input ?? null,
        });
      }
      this.entries.push(...created);
      return json(route, 201, { entries: created.map((e) => this.toEntry(e)) });
    }
    const id = decodeURIComponent(path.slice('/entries/'.length));
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return fail(route, 404, 'not_found');
    if (method === 'PATCH') {
      const patch = (body ?? {}) as Partial<NewEntry>;
      if (patch.amount_cents !== undefined) entry.amount_cents = patch.amount_cents;
      if (patch.description !== undefined) entry.description = patch.description;
      if (patch.occurred_at !== undefined) entry.occurred_at = patch.occurred_at;
      if (patch.note !== undefined) entry.note = patch.note;
      if (patch.currency !== undefined) entry.currency = patch.currency;
      if (patch.category_id !== undefined || patch.category !== undefined) {
        const c = this.resolveCategory(patch);
        entry.category_id = c?.id ?? null;
        entry.category_name = c?.name ?? null;
      }
      entry.updated_at = Date.now();
      return json(route, 200, { entry: this.toEntry(entry) });
    }
    if (method === 'DELETE') {
      this.entries = this.entries.filter((e) => e.id !== id);
      return route.fulfill({ status: 204 });
    }
    return fail(route, 404, 'not_found');
  }

  private inRange(from: string, to: string): StoredEntry[] {
    return this.entries.filter((e) => e.occurred_at.slice(0, 10) >= from && e.occurred_at.slice(0, 10) <= to);
  }

  summary(query: Record<string, string>): Summary {
    const from = query.from ?? '';
    const to = query.to ?? '';
    const cur = this.inRange(from, to);
    const prev = query.prev_from && query.prev_to ? this.inRange(query.prev_from, query.prev_to) : null;
    const byCat = new Map<string, SummaryCategory>();
    for (const e of cur) {
      const key = e.category_id ?? '';
      const row = byCat.get(key) ?? { category_id: e.category_id, name: e.category_name, total_cents: 0, count: 0 };
      row.total_cents += e.amount_cents;
      row.count += 1;
      byCat.set(key, row);
    }
    if (prev) {
      for (const row of byCat.values()) {
        const p = prev.filter((e) => (e.category_id ?? '') === (row.category_id ?? '')).reduce((s, e) => s + e.amount_cents, 0);
        if (p > 0) row.prev_total_cents = p;
      }
    }
    const byDay = new Map<string, { day: string; total_cents: number; count: number }>();
    for (const e of cur) {
      const day = e.occurred_at.slice(0, 10);
      const row = byDay.get(day) ?? { day, total_cents: 0, count: 0 };
      row.total_cents += e.amount_cents;
      row.count += 1;
      byDay.set(day, row);
    }
    return {
      from,
      to,
      total_cents: cur.reduce((s, e) => s + e.amount_cents, 0),
      count: cur.length,
      by_category: [...byCat.values()].sort((a, b) => b.total_cents - a.total_cents),
      by_day: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      ...(prev ? { previous: { total_cents: prev.reduce((s, e) => s + e.amount_cents, 0), count: prev.length } } : {}),
    };
  }

  csv(from: string, to: string): string {
    const q = (v: string | null) => {
      const s = v ?? '';
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.inRange(from, to)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
      .map((e) =>
        [e.occurred_at.slice(0, 10), e.occurred_at.slice(11, 16), (e.amount_cents / 100).toFixed(2), e.currency, q(e.description), q(e.category_name), q(e.note), e.source, e.id].join(','),
      );
    return `﻿date,time,amount,currency,description,category,note,source,id\r\n${rows.map((r) => `${r}\r\n`).join('')}`;
  }

  private exportCsv(route: Route, query: Record<string, string>): Promise<void> {
    const from = query.from ?? '';
    const to = query.to ?? '';
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tally-${from}_${to}.csv"` },
      body: this.csv(from, to),
    });
  }

  private pushRoute(route: Route, method: string, path: string, body: Record<string, unknown> | null): Promise<void> {
    if (path === '/push/vapid-public-key' && method === 'GET') return json(route, 200, { key: MOCK_VAPID_KEY });
    if (path === '/push/subscriptions' && method === 'GET') {
      return json(route, 200, { subscriptions: this.subscriptions.map(({ keys: _k, ...row }) => row) });
    }
    if (path === '/push/subscribe' && method === 'POST') {
      const sub = body?.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
      if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth) return fail(route, 400, 'validation', 'subscription');
      const now = Date.now();
      const existing = this.subscriptions.find((s) => s.endpoint === sub.endpoint);
      const lang = body?.lang === 'fr' ? 'fr' : 'en';
      const tz = typeof body?.tz === 'string' ? body.tz : 'UTC';
      if (existing) {
        Object.assign(existing, { lang, tz, last_seen_at: now, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
        return json(route, 200, { id: existing.id });
      }
      const row: StoredSub = {
        id: uuid(),
        endpoint: sub.endpoint,
        user_agent: typeof body?.user_agent === 'string' ? body.user_agent : null,
        lang,
        tz,
        created_at: now,
        last_seen_at: now,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      };
      this.subscriptions.push(row);
      return json(route, 200, { id: row.id });
    }
    if (path === '/push/test' && method === 'POST') {
      const endpoint = body?.endpoint;
      const sent = endpoint ? this.subscriptions.filter((s) => s.endpoint === endpoint).length : this.subscriptions.length;
      return json(route, 200, { sent });
    }
    if (path === '/push/skip' && method === 'POST') {
      this.skips.push(String(body?.day));
      return route.fulfill({ status: 204 });
    }
    const m = /^\/push\/subscriptions\/(.+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const sub = this.subscriptions.find((s) => s.id === id);
      if (!sub) return fail(route, 404, 'not_found');
      if (method === 'DELETE') {
        this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
        return route.fulfill({ status: 204 });
      }
      if (method === 'PATCH') {
        if (body?.lang === 'en' || body?.lang === 'fr') sub.lang = body.lang;
        if (typeof body?.tz === 'string') sub.tz = body.tz;
        return route.fulfill({ status: 204 });
      }
    }
    return fail(route, 404, 'not_found');
  }
}
