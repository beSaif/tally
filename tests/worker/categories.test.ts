import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { ApiErrorBody, CategoriesInput, Category, Entry, NewEntry } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/constants';
import { api, signup, type Session } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function list(s: Session): Promise<Category[]> {
  const res = await api('/api/categories', { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as { categories: Category[] }).categories;
}

async function put(s: Session, categories: CategoriesInput['categories']): Promise<Response> {
  return api('/api/categories', { method: 'PUT', body: { categories }, cookie: s.cookie });
}

async function replace(s: Session, categories: CategoriesInput['categories']): Promise<Category[]> {
  const res = await put(s, categories);
  expect(res.status).toBe(200);
  return ((await res.json()) as { categories: Category[] }).categories;
}

async function byName(s: Session): Promise<Record<string, Category>> {
  return Object.fromEntries((await list(s)).map((c) => [c.name, c]));
}

async function createEntries(s: Session, entries: Array<Partial<NewEntry>>): Promise<Entry[]> {
  const full = entries.map((e) => ({ amount_cents: 100, description: 'x', occurred_at: '2026-10-05T12:00', source: 'manual', ...e }));
  const res = await api('/api/entries', { body: { entries: full }, cookie: s.cookie });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function entriesOf(s: Session): Promise<Entry[]> {
  const res = await api('/api/entries?from=2026-10-01&to=2026-10-31', { cookie: s.cookie });
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return ((await res.json()) as ApiErrorBody).error;
}

const countFor = async (userId: string) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id = ?').bind(userId).first<{ n: number }>())?.n;

describe('category budget and fixed flag', () => {
  const patch = (s: Session, id: string, body: unknown) => api(`/api/categories/${id}`, { method: 'PATCH', body, cookie: s.cookie });

  it('sets and clears a budget, flags a fixed cost, and keeps both through a rename', async () => {
    const s = await signup();
    const { Dining, Bills } = await byName(s);
    let res = await patch(s, Dining!.id, { budget_cents: 25_000 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { category: Category }).category).toEqual({ ...Dining, budget_cents: 25_000 });
    res = await patch(s, Dining!.id, { fixed: true });
    expect(((await res.json()) as { category: Category }).category).toMatchObject({ budget_cents: 25_000, fixed: true });

    const renamed = await replace(s, (await list(s)).map((c) => ({ id: c.id, name: c.id === Dining!.id ? 'Eating out' : c.name })));
    expect(renamed.find((c) => c.id === Dining!.id)).toMatchObject({ name: 'Eating out', budget_cents: 25_000, fixed: true });

    res = await patch(s, Dining!.id, { budget_cents: null, fixed: false });
    expect(((await res.json()) as { category: Category }).category).toMatchObject({ budget_cents: null, fixed: false });
    expect((await byName(s)).Bills).toEqual(Bills);
  });

  it("rejects empty or bad changes and another user's category", async () => {
    const a = await signup();
    const b = await signup();
    const { Dining } = await byName(a);
    for (const body of [{}, { budget_cents: 50 }, { budget_cents: 1.5 }, { fixed: 'yes' }]) {
      const res = await patch(a, Dining!.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await patch(b, Dining!.id, { budget_cents: 10_000 });
    expect(res.status).toBe(404);
    expect((await byName(a)).Dining).toEqual(Dining);
    expect((await api(`/api/categories/${Dining!.id}`, { method: 'PATCH', body: { fixed: true } })).status).toBe(401);
  });
});

describe('categories', () => {
  it('requires a session', async () => {
    expect((await api('/api/categories')).status).toBe(401);
    const res = await api('/api/categories', { method: 'PUT', body: { categories: [] } });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('unauthorized');
  });

  it('lists the sign-up defaults in order', async () => {
    const s = await signup({ language: 'en' });
    const categories = await list(s);
    expect(categories.map((c) => c.name)).toEqual([...DEFAULT_CATEGORIES.en]);
    expect(categories.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Bills starts out as a fixed cost; no category has a budget.
    expect(categories.filter((c) => c.fixed).map((c) => c.name)).toEqual(['Bills']);
    for (const c of categories) {
      expect(Object.keys(c).sort()).toEqual(['budget_cents', 'fixed', 'id', 'name', 'position']);
      expect(c.budget_cents).toBeNull();
      expect(c.id).toMatch(UUID);
    }
  });

  it('keeps, renames, re-orders, deletes and creates in one call', async () => {
    const s = await signup();
    const before = await byName(s);
    const result = await replace(s, [
      { id: before.Dining!.id, name: 'Restaurants' },
      { name: 'Coffee' },
      { id: before.Groceries!.id, name: 'Groceries' },
    ]);
    expect(result.map((c) => [c.name, c.position])).toEqual([
      ['Restaurants', 0],
      ['Coffee', 1],
      ['Groceries', 2],
    ]);
    expect(result[0]!.id).toBe(before.Dining!.id);
    expect(result[2]!.id).toBe(before.Groceries!.id);
    expect(result[1]!.id).toMatch(UUID);
    expect(Object.values(before).map((c) => c.id)).not.toContain(result[1]!.id);
    expect(await list(s)).toEqual(result);
    expect(await countFor(s.userId)).toBe(3);
  });

  it('carries entries through a rename and uncategorises them on delete', async () => {
    const s = await signup();
    const before = await byName(s);
    const [dining, transport] = await createEntries(s, [
      { description: 'Dinner', category: 'Dining' },
      { description: 'Train', category: 'Transport' },
    ]);
    expect(transport!.category_id).toBe(before.Transport!.id);

    await replace(s, [{ id: before.Dining!.id, name: 'Eating out' }]);
    const after = Object.fromEntries((await entriesOf(s)).map((e) => [e.id, e]));
    expect(after[dining!.id]).toMatchObject({ category_id: before.Dining!.id, category_name: 'Eating out' });
    expect(after[transport!.id]).toMatchObject({ category_id: null, category_name: null });
    // The entry itself survives the category's deletion.
    expect(after[transport!.id]!.description).toBe('Train');
  });

  it('handles swaps, case-only renames and re-adding a removed name', async () => {
    const s = await signup();
    const before = await byName(s);
    const swapped = await replace(s, [
      { id: before.Groceries!.id, name: 'Dining' },
      { id: before.Dining!.id, name: 'Groceries' },
      { id: before.Fun!.id, name: 'FUN' },
    ]);
    expect(swapped.map((c) => [c.id, c.name])).toEqual([
      [before.Groceries!.id, 'Dining'],
      [before.Dining!.id, 'Groceries'],
      [before.Fun!.id, 'FUN'],
    ]);

    // A rotation (A→B, B→C, C→A) needs the same care as a swap.
    const rotated = await replace(s, [
      { id: before.Groceries!.id, name: 'Groceries' },
      { id: before.Dining!.id, name: 'FUN' },
      { id: before.Fun!.id, name: 'Dining' },
    ]);
    expect(rotated.map((c) => c.name)).toEqual(['Groceries', 'FUN', 'Dining']);

    // Dropping a category and adding the same name back creates a new one; old links are cut.
    const [entry] = await createEntries(s, [{ category_id: before.Fun!.id }]);
    const readded = await replace(s, [{ id: before.Groceries!.id, name: 'Groceries' }, { name: 'dining' }]);
    expect(readded[1]!.name).toBe('dining');
    expect(readded[1]!.id).not.toBe(before.Fun!.id);
    expect((await entriesOf(s)).find((e) => e.id === entry!.id)!.category_id).toBeNull();
  });

  it('rejects duplicate names case-insensitively and leaves the list untouched', async () => {
    const s = await signup({ language: 'fr' });
    const before = await list(s);
    const sante = before.find((c) => c.name === 'Santé')!;
    const cases: CategoriesInput['categories'][] = [
      [{ name: 'Food' }, { name: 'food' }],
      [{ name: 'Food' }, { name: '  FOOD  ' }],
      [{ id: sante.id, name: 'Santé' }, { name: 'SANTÉ' }],
      [{ name: 'Café' }, { name: 'Café' }], // same word, decomposed accent
    ];
    for (const categories of cases) {
      const res = await put(s, categories);
      expect(res.status, JSON.stringify(categories)).toBe(400);
      const err = await errorOf(res);
      expect(err.code).toBe('validation');
      expect(err.message).toMatch(/^categories\.1\.name: /);
    }
    const twice = await put(s, [
      { id: sante.id, name: 'Santé' },
      { id: sante.id, name: 'Health' },
    ]);
    expect(twice.status).toBe(400);
    expect((await errorOf(twice)).message).toMatch(/^categories\.1\.id: /);
    expect(await list(s)).toEqual(before);
  });

  it('validates names and ids', async () => {
    const s = await signup();
    const before = await list(s);
    const bad: unknown[] = [
      { categories: [{ name: '' }] },
      { categories: [{ name: '   ' }] },
      { categories: [{ name: 'x'.repeat(41) }] },
      { categories: [{ name: 'Food', id: 'food' }] },
      { categories: Array.from({ length: 61 }, (_, i) => ({ name: `Category ${i}` })) },
      { categories: 'Food' },
      {},
    ];
    for (const body of bad) {
      const res = await api('/api/categories', { method: 'PUT', body, cookie: s.cookie });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await errorOf(res)).code).toBe('validation');
    }
    const form = await api('/api/categories', { method: 'PUT', raw: 'name=Food', headers: { 'Content-Type': 'text/plain' }, cookie: s.cookie });
    expect(form.status).toBe(400);
    expect(await list(s)).toEqual(before);

    const trimmed = await replace(s, [{ name: '  Coffee  ' }, { name: 'x'.repeat(40) }]);
    expect(trimmed.map((c) => c.name)).toEqual(['Coffee', 'x'.repeat(40)]);
    const sixty = await replace(s, Array.from({ length: 60 }, (_, i) => ({ name: `Category ${i}` })));
    expect(sixty).toHaveLength(60);
    expect(sixty[59]).toMatchObject({ name: 'Category 59', position: 59 });
  });

  it("treats another user's ids, and unknown ids, as new categories", async () => {
    const a = await signup();
    const b = await signup();
    const aBefore = await list(a);
    const aDining = aBefore.find((c) => c.name === 'Dining')!;
    const unknown = crypto.randomUUID();

    const result = await replace(b, [
      { id: aDining.id, name: 'Mine now?' },
      { id: unknown, name: 'Invented' },
    ]);
    expect(result.map((c) => c.name)).toEqual(['Mine now?', 'Invented']);
    expect(result[0]!.id).not.toBe(aDining.id);
    expect(result[1]!.id).not.toBe(unknown);
    expect(await list(a)).toEqual(aBefore);
    expect(await countFor(b.userId)).toBe(2);
  });

  it('removes every category with an empty list', async () => {
    const s = await signup();
    const [entry] = await createEntries(s, [{ category: 'Bills' }]);
    expect(await replace(s, [])).toEqual([]);
    expect(await countFor(s.userId)).toBe(0);
    expect((await entriesOf(s)).find((e) => e.id === entry!.id)).toMatchObject({ category_id: null, category_name: null });
  });

  it("only ever touches the caller's categories", async () => {
    const a = await signup();
    const b = await signup();
    const bBefore = await list(b);
    const aCats = await list(a);
    await replace(a, [{ id: aCats[0]!.id, name: 'Only one' }]);
    expect(await list(b)).toEqual(bBefore);
    expect(await countFor(b.userId)).toBe(bBefore.length);
  });
});
