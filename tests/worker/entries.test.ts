import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { ApiErrorBody, Category, Entry, NewEntry } from '@shared/api';
import { maybeSendBudgetAlerts } from '../../src/worker/push/notify';
import type { app as App } from '../../src/worker/index';
import { api, ORIGIN, signup, type Session } from './helpers';

vi.mock('../../src/worker/push/notify', () => ({ maybeSendBudgetAlerts: vi.fn(async () => undefined) }));
const budgetAlerts = vi.mocked(maybeSendBudgetAlerts);

// The pool imports the Worker before this file's mocks are registered, so a static import of it
// still holds the real push module; resetModules plus a fresh import rebuilds it with the mock.
// The hook tests call that app directly with their own ExecutionContext, so they can wait for the
// waitUntil work as well.
let app: typeof App;
beforeAll(async () => {
  vi.resetModules();
  ({ app } = await import('../../src/worker/index'));
});
beforeEach(() => {
  budgetAlerts.mockReset();
  budgetAlerts.mockResolvedValue(undefined);
});

const ENTRY_KEYS = ['amount_cents', 'category_id', 'category_name', 'created_at', 'currency', 'description', 'id', 'note', 'occurred_at', 'source', 'updated_at'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const entry = (over: Partial<NewEntry> = {}): NewEntry => ({
  amount_cents: 450,
  description: 'Coffee',
  occurred_at: '2026-10-05T08:15',
  source: 'text',
  ...over,
});

async function create(s: Session, entries: NewEntry[]): Promise<Entry[]> {
  const res = await api('/api/entries', { body: { entries }, cookie: s.cookie });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function list(s: Session, from: string, to: string): Promise<Entry[]> {
  const res = await api(`/api/entries?from=${from}&to=${to}`, { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function patch(s: Session, id: string, body: unknown): Promise<Response> {
  return api(`/api/entries/${id}`, { method: 'PATCH', body, cookie: s.cookie });
}

async function categoryIds(s: Session): Promise<Record<string, string>> {
  const res = await api('/api/categories', { cookie: s.cookie });
  const { categories } = (await res.json()) as { categories: Category[] };
  return Object.fromEntries(categories.map((c) => [c.name, c.id]));
}

async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return ((await res.json()) as ApiErrorBody).error;
}

describe('entries', () => {
  it('requires a session', async () => {
    const id = crypto.randomUUID();
    for (const res of [
      await api('/api/entries?from=2026-10-01&to=2026-10-31'),
      await api('/api/entries', { body: { entries: [entry()] } }),
      await api(`/api/entries/${id}`, { method: 'PATCH', body: { amount_cents: 1 } }),
      await api(`/api/entries/${id}`, { method: 'DELETE' }),
    ]) {
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe('unauthorized');
    }
  });

  it('creates an entry and returns exactly the Entry shape', async () => {
    const s = await signup();
    const res = await api('/api/entries', { body: { entries: [entry({ raw_input: 'coffee 4.50' })] }, cookie: s.cookie });
    expect(res.status).toBe(201);
    const { entries } = (await res.json()) as { entries: Entry[] };
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(Object.keys(e).sort()).toEqual(ENTRY_KEYS); // raw_input stays server-side
    expect(e).toMatchObject({
      amount_cents: 450,
      currency: 'CHF',
      description: 'Coffee',
      category_id: null,
      category_name: null,
      occurred_at: '2026-10-05T08:15',
      note: null,
      source: 'text',
    });
    expect(e.id).toMatch(UUID);
    expect(e.created_at).toBeTypeOf('number');
    expect(e.updated_at).toBe(e.created_at);

    const stored = await env.DB.prepare('SELECT user_id, raw_input FROM entries WHERE id = ?').bind(e.id).first<{ user_id: string; raw_input: string }>();
    expect(stored).toEqual({ user_id: s.userId, raw_input: 'coffee 4.50' });
    expect(await list(s, '2026-10-05', '2026-10-05')).toEqual(entries);
  });

  it("defaults the currency to the user's setting", async () => {
    const s = await signup();
    expect((await api('/api/settings', { method: 'PUT', body: { currency: 'EUR' }, cookie: s.cookie })).status).toBe(200);
    const [implicit, explicit] = await create(s, [entry(), entry({ currency: 'USD' })]);
    expect(implicit!.currency).toBe('EUR');
    expect(explicit!.currency).toBe('USD');
  });

  it('creates a batch in payload order, resolving category names case-insensitively', async () => {
    const s = await signup();
    const ids = await categoryIds(s);
    const created = await create(s, [
      entry({ description: 'Migros', category: 'groceries', amount_cents: 2340 }),
      entry({ description: 'Lunch', category: 'DINING', amount_cents: 1800 }),
      entry({ description: 'Lottery', category: 'Gambling', amount_cents: 500 }),
      entry({ description: 'Gift', category: null, amount_cents: 2500 }),
      entry({ description: 'Stamp', category: '', amount_cents: 120 }),
    ]);
    expect(created.map((e) => [e.description, e.category_id, e.category_name])).toEqual([
      ['Migros', ids.Groceries, 'Groceries'],
      ['Lunch', ids.Dining, 'Dining'],
      ['Lottery', null, null],
      ['Gift', null, null],
      ['Stamp', null, null],
    ]);
    expect(new Set(created.map((e) => e.id)).size).toBe(5);
  });

  it('matches accented category names regardless of case', async () => {
    const s = await signup({ language: 'fr' });
    const ids = await categoryIds(s);
    const [e] = await create(s, [entry({ description: 'Pharmacie', category: 'SANTÉ' })]);
    expect(e!.category_id).toBe(ids['Santé']);
    expect(e!.category_name).toBe('Santé');
  });

  it("lets category_id win over the name, and only accepts the user's own ids", async () => {
    const s = await signup();
    const other = await signup();
    const ids = await categoryIds(s);
    const otherIds = await categoryIds(other);
    const created = await create(s, [
      entry({ description: 'by id', category_id: ids.Dining, category: 'Groceries' }),
      entry({ description: 'foreign id', category_id: otherIds.Dining, category: 'Groceries' }),
      entry({ description: 'unknown id', category_id: crypto.randomUUID() }),
      entry({ description: 'explicit none', category_id: null, category: 'Groceries' }),
    ]);
    expect(created.map((e) => [e.description, e.category_id, e.category_name])).toEqual([
      ['by id', ids.Dining, 'Dining'],
      ['foreign id', null, null],
      ['unknown id', null, null],
      ['explicit none', null, null],
    ]);
  });

  it('trims text and stores an empty note as null', async () => {
    const s = await signup();
    const [blank, kept] = await create(s, [
      entry({ description: '  Lunch  ', note: '   ' }),
      entry({ note: '  split with Sam, total 42.00 ' }),
    ]);
    expect(blank!.description).toBe('Lunch');
    expect(blank!.note).toBeNull();
    expect(kept!.note).toBe('split with Sam, total 42.00');
  });

  it('validates the whole batch before writing anything', async () => {
    const s = await signup();
    const bad: Array<[unknown, string]> = [
      [{ entries: [] }, 'entries'],
      [{ entries: Array.from({ length: 51 }, () => entry()) }, 'entries'],
      [{ entries: [entry(), entry({ amount_cents: -1 })] }, 'entries.1.amount_cents'],
      [{ entries: [entry({ amount_cents: 4.5 })] }, 'entries.0.amount_cents'],
      [{ entries: [entry({ amount_cents: 1_000_000_001 })] }, 'entries.0.amount_cents'],
      [{ entries: [entry({ description: '   ' })] }, 'entries.0.description'],
      [{ entries: [entry({ description: 'x'.repeat(201) })] }, 'entries.0.description'],
      [{ entries: [entry({ occurred_at: '2026-10-05 08:15' })] }, 'entries.0.occurred_at'],
      [{ entries: [entry({ occurred_at: '2026-02-30T08:15' })] }, 'entries.0.occurred_at'],
      [{ entries: [entry({ occurred_at: '2026-10-05T24:00' })] }, 'entries.0.occurred_at'],
      [{ entries: [entry({ currency: 'chf' })] }, 'entries.0.currency'],
      [{ entries: [entry({ source: 'fax' as NewEntry['source'] })] }, 'entries.0.source'],
      [{ entries: [entry({ category_id: 'dining' })] }, 'entries.0.category_id'],
      [{ entries: [entry({ note: 'x'.repeat(501) })] }, 'entries.0.note'],
      [{ entries: [{ amount_cents: 100, description: 'No source', occurred_at: '2026-10-05T08:15' }] }, 'entries.0.source'],
      [{}, 'entries'],
    ];
    for (const [body, path] of bad) {
      const res = await api('/api/entries', { body, cookie: s.cookie });
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      const err = await errorOf(res);
      expect(err.code).toBe('validation');
      expect(err.message.startsWith(`${path}:`), err.message).toBe(true);
    }
    const form = await api('/api/entries', { method: 'POST', raw: 'amount=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cookie: s.cookie });
    expect(form.status).toBe(400);
    expect(await list(s, '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('lists an inclusive day range, newest first', async () => {
    const s = await signup();
    await create(s, [
      entry({ description: 'before', occurred_at: '2026-09-30T23:59' }),
      entry({ description: 'first minute', occurred_at: '2026-10-01T00:00' }),
      entry({ description: 'middle', occurred_at: '2026-10-15T12:00' }),
      entry({ description: 'last minute', occurred_at: '2026-10-31T23:59' }),
      entry({ description: 'after', occurred_at: '2026-11-01T00:00' }),
    ]);
    const entries = await list(s, '2026-10-01', '2026-10-31');
    expect(entries.map((e) => e.description)).toEqual(['last minute', 'middle', 'first minute']);
    expect((await list(s, '2026-10-15', '2026-10-15')).map((e) => e.description)).toEqual(['middle']);
  });

  it('orders entries of the same minute by creation time, newest first', async () => {
    const s = await signup();
    const [a, b, c] = await create(s, [entry({ description: 'a' }), entry({ description: 'b' }), entry({ description: 'c' })]);
    const setCreated = (id: string, at: number) => env.DB.prepare('UPDATE entries SET created_at = ? WHERE id = ?').bind(at, id).run();
    await setCreated(a!.id, 3000);
    await setCreated(b!.id, 1000);
    await setCreated(c!.id, 2000);
    expect((await list(s, '2026-10-05', '2026-10-05')).map((e) => e.description)).toEqual(['a', 'c', 'b']);
  });

  it('validates the range', async () => {
    const s = await signup();
    const bad: Array<[string, string]> = [
      ['', 'from'],
      ['?from=2026-10-01', 'to'],
      ['?from=2026-10-31&to=2026-10-01', 'to'],
      ['?from=2026-02-30&to=2026-03-01', 'from'],
      ['?from=2026-10-01&to=20261031', 'to'],
      ['?from=2025-01-01&to=2026-01-02', 'to'], // 367 days
    ];
    for (const [query, path] of bad) {
      const res = await api(`/api/entries${query}`, { cookie: s.cookie });
      expect(res.status, query).toBe(400);
      const err = await errorOf(res);
      expect(err.code).toBe('validation');
      expect(err.message.startsWith(`${path}:`), err.message).toBe(true);
    }
    // A leap year is the longest allowed range.
    expect((await api('/api/entries?from=2024-01-01&to=2024-12-31', { cookie: s.cookie })).status).toBe(200);
    expect((await api('/api/entries?from=2025-01-01&to=2026-01-01', { cookie: s.cookie })).status).toBe(200);
  });

  it('patches only the fields that are sent', async () => {
    const s = await signup();
    const ids = await categoryIds(s);
    const [original] = await create(s, [entry({ description: 'Dinner', category: 'Dining', note: 'with Sam', amount_cents: 4200 })]);
    const e = original!;

    const res = await patch(s, e.id, { amount_cents: 2100 });
    expect(res.status).toBe(200);
    const { entry: updated } = (await res.json()) as { entry: Entry };
    expect(Object.keys(updated).sort()).toEqual(ENTRY_KEYS);
    expect(updated).toEqual({ ...e, amount_cents: 2100, updated_at: updated.updated_at });
    expect(updated.updated_at).toBeGreaterThan(e.updated_at);

    const all = (await (
      await patch(s, e.id, {
        description: '  Dinner, Bains des Pâquis ',
        occurred_at: '2026-10-04T20:14',
        currency: 'EUR',
        source: 'manual',
        note: null,
        category: 'transport',
      })
    ).json()) as { entry: Entry };
    expect(all.entry).toMatchObject({
      id: e.id,
      amount_cents: 2100,
      currency: 'EUR',
      description: 'Dinner, Bains des Pâquis',
      category_id: ids.Transport,
      category_name: 'Transport',
      occurred_at: '2026-10-04T20:14',
      note: null,
      source: 'manual',
      created_at: e.created_at,
    });

    const cleared = (await (await patch(s, e.id, { category_id: null })).json()) as { entry: Entry };
    expect(cleared.entry.category_id).toBeNull();
    expect(cleared.entry.category_name).toBeNull();
    const byId = (await (await patch(s, e.id, { category_id: ids.Fun })).json()) as { entry: Entry };
    expect(byId.entry.category_name).toBe('Fun');
    const unknown = (await (await patch(s, e.id, { category: 'Nope' })).json()) as { entry: Entry };
    expect(unknown.entry.category_id).toBeNull();

    const before = unknown.entry.updated_at;
    const empty = (await (await patch(s, e.id, {})).json()) as { entry: Entry };
    expect(empty.entry).toEqual({ ...unknown.entry, updated_at: empty.entry.updated_at });
    expect(empty.entry.updated_at).toBeGreaterThan(before);

    expect(await list(s, '2026-10-04', '2026-10-04')).toEqual([empty.entry]);
  });

  it('rejects bad patches and unknown ids', async () => {
    const s = await signup();
    const [e] = await create(s, [entry()]);
    for (const body of [{ amount_cents: -5 }, { description: '' }, { occurred_at: 'yesterday' }, { source: 'fax' }, { category_id: 'x' }]) {
      const res = await patch(s, e!.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).code).toBe('validation');
    }
    for (const id of [crypto.randomUUID(), 'not-an-id']) {
      const res = await patch(s, id, { amount_cents: 1 });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe('not_found');
    }
    expect((await list(s, '2026-10-05', '2026-10-05'))[0]).toEqual(e);
  });

  it('deletes an entry once', async () => {
    const s = await signup();
    const [keep, drop] = await create(s, [entry({ description: 'keep' }), entry({ description: 'drop' })]);
    const res = await api(`/api/entries/${drop!.id}`, { method: 'DELETE', cookie: s.cookie });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const again = await api(`/api/entries/${drop!.id}`, { method: 'DELETE', cookie: s.cookie });
    expect(again.status).toBe(404);
    expect((await errorOf(again)).code).toBe('not_found');
    expect(await list(s, '2026-10-05', '2026-10-05')).toEqual([keep]);
  });

  it("never shows, changes or deletes another user's entries", async () => {
    const a = await signup();
    const b = await signup();
    const [mine] = await create(a, [entry({ description: 'A only', category: 'Dining' })]);
    const theirs = mine!;

    expect(await list(b, '2026-10-01', '2026-10-31')).toEqual([]);
    const p = await patch(b, theirs.id, { amount_cents: 1, description: 'hijacked' });
    expect(p.status).toBe(404);
    const d = await api(`/api/entries/${theirs.id}`, { method: 'DELETE', cookie: b.cookie });
    expect(d.status).toBe(404);
    expect(await list(a, '2026-10-05', '2026-10-05')).toEqual([theirs]);

    // B pointing an entry at A's category gets an uncategorised entry, not a link into A's data.
    const [bEntry] = await create(b, [entry({ category_id: theirs.category_id })]);
    expect(bEntry!.category_id).toBeNull();
    const moved = (await (await patch(b, bEntry!.id, { category_id: theirs.category_id })).json()) as { entry: Entry };
    expect(moved.entry.category_id).toBeNull();
    expect(moved.entry.category_name).toBeNull();
  });
});

/** Calls the app in this isolate (where the push module is mocked) and waits for its waitUntil work. */
async function direct(s: Session, method: string, path: string, body?: unknown, withCtx = true): Promise<Response> {
  const ctx = withCtx ? createExecutionContext() : undefined;
  const headers: Record<string, string> = { Origin: ORIGIN, Cookie: s.cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env, ctx);
  if (ctx) await waitOnExecutionContext(ctx);
  return res;
}

describe('budget alert hook', () => {
  it('runs once per batch, inside waitUntil, with the latest occurred_at', async () => {
    const s = await signup();
    let finished = false;
    budgetAlerts.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });
    const res = await direct(s, 'POST', '/api/entries', {
      entries: [entry({ occurred_at: '2026-10-03T10:00' }), entry({ occurred_at: '2026-10-05T09:00' }), entry({ occurred_at: '2026-10-04T23:30' })],
    });
    expect(res.status).toBe(201);
    expect(budgetAlerts).toHaveBeenCalledTimes(1);
    expect(budgetAlerts).toHaveBeenCalledWith(expect.objectContaining({ DB: expect.anything() }), s.userId, '2026-10-05T09:00');
    expect(finished).toBe(true); // waitOnExecutionContext only waits for promises handed to waitUntil
  });

  it('runs after a patch with the entry’s new time, but not after a delete or a failed write', async () => {
    const s = await signup();
    const [e] = await create(s, [entry({ occurred_at: '2026-10-01T08:00' })]);
    const id = e!.id;
    budgetAlerts.mockClear();

    expect((await direct(s, 'PATCH', `/api/entries/${id}`, { amount_cents: 999 })).status).toBe(200);
    expect(budgetAlerts).toHaveBeenLastCalledWith(expect.anything(), s.userId, '2026-10-01T08:00');
    expect((await direct(s, 'PATCH', `/api/entries/${id}`, { occurred_at: '2026-09-30T12:00' })).status).toBe(200);
    expect(budgetAlerts).toHaveBeenLastCalledWith(expect.anything(), s.userId, '2026-09-30T12:00');
    expect(budgetAlerts).toHaveBeenCalledTimes(2);

    budgetAlerts.mockClear();
    expect((await direct(s, 'PATCH', `/api/entries/${crypto.randomUUID()}`, { amount_cents: 1 })).status).toBe(404);
    expect((await direct(s, 'PATCH', `/api/entries/${id}`, { amount_cents: -1 })).status).toBe(400);
    expect((await direct(s, 'POST', '/api/entries', { entries: [] })).status).toBe(400);
    expect((await direct(s, 'DELETE', `/api/entries/${id}`)).status).toBe(204);
    expect(budgetAlerts).not.toHaveBeenCalled();
  });

  it('cannot break a write, whether it rejects or throws', async () => {
    const s = await signup();
    budgetAlerts.mockRejectedValueOnce(new Error('push service down'));
    const created = await direct(s, 'POST', '/api/entries', { entries: [entry()] });
    expect(created.status).toBe(201);
    const [e] = ((await created.json()) as { entries: Entry[] }).entries;

    budgetAlerts.mockImplementationOnce(() => {
      throw new Error('synchronous failure');
    });
    const res = await direct(s, 'PATCH', `/api/entries/${e!.id}`, { amount_cents: 500 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entry: Entry }).entry.amount_cents).toBe(500);
    expect(budgetAlerts).toHaveBeenCalledTimes(2);
  });

  it('is skipped, not fatal, when there is no ExecutionContext', async () => {
    const s = await signup();
    const res = await direct(s, 'POST', '/api/entries', { entries: [entry()] }, false);
    expect(res.status).toBe(201);
    expect(budgetAlerts).not.toHaveBeenCalled();
    expect(await list(s, '2026-10-05', '2026-10-05')).toHaveLength(1);
  });
});
