import { describe, expect, it } from 'vitest';
import type { ApiErrorBody, Category, NewEntry, Summary } from '@shared/api';
import { api, signup, type Session } from './helpers';

async function createEntries(s: Session, entries: Array<Partial<NewEntry>>): Promise<void> {
  const full = entries.map((e) => ({ amount_cents: 100, description: 'x', occurred_at: '2026-10-05T12:00', source: 'manual', ...e }));
  const res = await api('/api/entries', { body: { entries: full }, cookie: s.cookie });
  expect(res.status).toBe(201);
}

async function summary(s: Session, query: string): Promise<Summary> {
  const res = await api(`/api/summary?${query}`, { cookie: s.cookie });
  expect(res.status, query).toBe(200);
  return (await res.json()) as Summary;
}

async function categoryIds(s: Session): Promise<Record<string, string>> {
  const res = await api('/api/categories', { cookie: s.cookie });
  const { categories } = (await res.json()) as { categories: Category[] };
  return Object.fromEntries(categories.map((c) => [c.name, c.id]));
}

async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return ((await res.json()) as ApiErrorBody).error;
}

/** October 2026 plus a September to compare with, and one entry on each side of October. */
async function seed(s: Session): Promise<void> {
  await createEntries(s, [
    { occurred_at: '2026-10-01T08:00', category: 'Groceries', amount_cents: 2340 },
    { occurred_at: '2026-10-01T12:30', category: 'Dining', amount_cents: 4200 },
    { occurred_at: '2026-10-03T19:00', category: 'Groceries', amount_cents: 1660 },
    { occurred_at: '2026-10-05T09:00', amount_cents: 450 },
    { occurred_at: '2026-10-31T23:59', category: 'Transport', amount_cents: 2280 },
    { occurred_at: '2026-11-01T00:00', category: 'Groceries', amount_cents: 5000 },
    { occurred_at: '2026-09-30T23:59', category: 'Dining', amount_cents: 9999 },
    { occurred_at: '2026-09-10T18:00', category: 'Groceries', amount_cents: 1000 },
    { occurred_at: '2026-09-12T21:00', category: 'Fun', amount_cents: 700 },
    { occurred_at: '2026-09-15T10:00', amount_cents: 300 },
  ]);
}

describe('summary', () => {
  it('requires a session', async () => {
    const res = await api('/api/summary?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('unauthorized');
  });

  it('totals a range by category (largest first) and by day', async () => {
    const s = await signup();
    const ids = await categoryIds(s);
    await seed(s);
    expect(await summary(s, 'from=2026-10-01&to=2026-10-31')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      total_cents: 10930,
      count: 5,
      by_category: [
        { category_id: ids.Dining, name: 'Dining', total_cents: 4200, count: 1 },
        { category_id: ids.Groceries, name: 'Groceries', total_cents: 4000, count: 2 },
        { category_id: ids.Transport, name: 'Transport', total_cents: 2280, count: 1 },
        { category_id: null, name: null, total_cents: 450, count: 1 },
      ],
      by_day: [
        { day: '2026-10-01', total_cents: 6540, count: 2 },
        { day: '2026-10-03', total_cents: 1660, count: 1 },
        { day: '2026-10-05', total_cents: 450, count: 1 },
        { day: '2026-10-31', total_cents: 2280, count: 1 },
      ],
    });
  });

  it('compares with a previous range', async () => {
    const s = await signup();
    const ids = await categoryIds(s);
    await seed(s);
    const result = await summary(s, 'from=2026-10-01&to=2026-10-31&prev_from=2026-09-01&prev_to=2026-09-30');
    expect(result.previous).toEqual({ total_cents: 11999, count: 4 });
    // Fun only appears in September, so it is not added to October's list.
    expect(result.by_category).toEqual([
      { category_id: ids.Dining, name: 'Dining', total_cents: 4200, count: 1, prev_total_cents: 9999 },
      { category_id: ids.Groceries, name: 'Groceries', total_cents: 4000, count: 2, prev_total_cents: 1000 },
      { category_id: ids.Transport, name: 'Transport', total_cents: 2280, count: 1, prev_total_cents: 0 },
      { category_id: null, name: null, total_cents: 450, count: 1, prev_total_cents: 300 },
    ]);
    expect(result.total_cents).toBe(10930);
    expect(result.by_day).toHaveLength(4);
  });

  it('answers an empty range with zeros', async () => {
    const s = await signup();
    await seed(s);
    expect(await summary(s, 'from=2027-01-01&to=2027-01-31')).toEqual({
      from: '2027-01-01',
      to: '2027-01-31',
      total_cents: 0,
      count: 0,
      by_category: [],
      by_day: [],
    });
    const withPrev = await summary(s, 'from=2027-01-01&to=2027-01-31&prev_from=2026-12-01&prev_to=2026-12-31');
    expect(withPrev.previous).toEqual({ total_cents: 0, count: 0 });
  });

  it('breaks ties by name and lists uncategorised last', async () => {
    const s = await signup();
    await createEntries(s, [
      { amount_cents: 500 },
      { category: 'Fun', amount_cents: 500 },
      { category: 'Bills', amount_cents: 200 },
      { category: 'Bills', amount_cents: 300 },
      { category: 'Home', amount_cents: 900 },
    ]);
    const { by_category } = await summary(s, 'from=2026-10-05&to=2026-10-05');
    expect(by_category.map((c) => [c.name, c.total_cents])).toEqual([
      ['Home', 900],
      ['Bills', 500],
      ['Fun', 500],
      [null, 500],
    ]);
  });

  it('folds entries of a deleted category into uncategorised', async () => {
    const s = await signup();
    const ids = await categoryIds(s);
    await createEntries(s, [
      { category: 'Dining', amount_cents: 4200 },
      { category: 'Dining', amount_cents: 800 },
      { amount_cents: 450 },
      { category: 'Groceries', amount_cents: 1000 },
    ]);
    const res = await api('/api/categories', { method: 'PUT', body: { categories: [{ id: ids.Groceries, name: 'Groceries' }] }, cookie: s.cookie });
    expect(res.status).toBe(200);
    const result = await summary(s, 'from=2026-10-01&to=2026-10-31');
    expect(result.by_category).toEqual([
      { category_id: null, name: null, total_cents: 5450, count: 3 },
      { category_id: ids.Groceries, name: 'Groceries', total_cents: 1000, count: 1 },
    ]);
    expect(result.total_cents).toBe(6450);
  });

  it('validates the ranges', async () => {
    const s = await signup();
    const bad: Array<[string, string]> = [
      ['from=2026-10-01', 'to'],
      ['from=2026-10-31&to=2026-10-01', 'to'],
      ['from=2025-01-01&to=2026-01-02', 'to'],
      ['from=2026-10-01&to=2026-10-31&prev_from=2026-09-01', 'prev_from'],
      ['from=2026-10-01&to=2026-10-31&prev_to=2026-09-30', 'prev_from'],
      ['from=2026-10-01&to=2026-10-31&prev_from=2026-09-30&prev_to=2026-09-01', 'prev_to'],
      ['from=2026-10-01&to=2026-10-31&prev_from=2024-01-01&prev_to=2026-09-30', 'prev_to'],
      ['from=2026-10-01&to=2026-10-31&prev_from=2026-09-31&prev_to=2026-09-30', 'prev_from'],
    ];
    for (const [query, path] of bad) {
      const res = await api(`/api/summary?${query}`, { cookie: s.cookie });
      expect(res.status, query).toBe(400);
      const err = await errorOf(res);
      expect(err.code).toBe('validation');
      expect(err.message.startsWith(`${path}:`), `${query} → ${err.message}`).toBe(true);
    }
    expect((await summary(s, 'from=2024-01-01&to=2024-12-31&prev_from=2023-01-01&prev_to=2023-12-31')).count).toBe(0);
  });

  it("never counts another user's entries", async () => {
    const a = await signup();
    const b = await signup();
    await seed(a);
    await createEntries(b, [
      { occurred_at: '2026-10-02T10:00', category: 'Dining', amount_cents: 100_000 },
      { occurred_at: '2026-09-02T10:00', amount_cents: 70_000 },
    ]);
    const query = 'from=2026-10-01&to=2026-10-31&prev_from=2026-09-01&prev_to=2026-09-30';
    const aResult = await summary(a, query);
    expect(aResult.total_cents).toBe(10930);
    expect(aResult.previous).toEqual({ total_cents: 11999, count: 4 });
    expect(aResult.by_day.find((d) => d.day === '2026-10-02')).toBeUndefined();

    const bResult = await summary(b, query);
    expect(bResult).toMatchObject({ total_cents: 100_000, count: 1, previous: { total_cents: 70_000, count: 1 } });
    expect(bResult.by_category).toEqual([
      { category_id: (await categoryIds(b)).Dining, name: 'Dining', total_cents: 100_000, count: 1, prev_total_cents: 0 },
    ]);
  });
});
