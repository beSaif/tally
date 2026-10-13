import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Bill, BillDetail, BillsSync, BillSuggestion, Category, Entry, NewBill, NewEntry } from '@shared/api';
import { patternKey } from '@shared/bills';
import { api, signup, type Session } from './helpers';

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function categoryId(s: Session, name: string): Promise<string> {
  const { categories } = await json<{ categories: Category[] }>(await api('/api/categories', { cookie: s.cookie }));
  return categories.find((c) => c.name === name)!.id;
}

async function create(s: Session, input: Partial<NewBill> = {}): Promise<{ bill: Bill; entry: Entry | null }> {
  const body: NewBill = { amount_cents: 4_500, description: 'Swisscom mobile', cadence: 'monthly', first_due: '2026-10-14', mode: 'ask', ...input };
  const res = await api('/api/bills', { body, cookie: s.cookie });
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}

async function entriesIn(s: Session, from: string, to: string): Promise<Entry[]> {
  return (await json<{ entries: Entry[] }>(await api(`/api/entries?from=${from}&to=${to}`, { cookie: s.cookie }))).entries;
}

describe('bills', () => {
  it('creates a bill with the account currency and its own category, and lists it', async () => {
    const s = await signup();
    const bills = await categoryId(s, 'Bills');
    const { bill, entry } = await create(s, { category_id: bills });
    expect(entry).toBeNull();
    expect(bill).toMatchObject({ amount_cents: 4_500, currency: 'CHF', category_id: bills, category_name: 'Bills', cadence: 'monthly', anchor: '2026-10-14', next_due: '2026-10-14', mode: 'ask' });
    const { bills: listed } = await json<{ bills: Bill[] }>(await api('/api/bills', { cookie: s.cookie }));
    expect(listed).toEqual([bill]);
  });

  it('logs the first payment when it is already paid, linked to the bill', async () => {
    const s = await signup();
    const { bill, entry } = await create(s, { description: 'Rent', amount_cents: 125_000, first_due: '2026-10-01', paid_at: '2026-10-01T08:30', source: 'text', raw_input: 'rent 1250 monthly' });
    expect(bill.next_due).toBe('2026-11-01');
    expect(bill.anchor).toBe('2026-10-01');
    expect(entry).toMatchObject({ description: 'Rent', amount_cents: 125_000, occurred_at: '2026-10-01T08:30', bill_id: bill.id, source: 'text' });
    expect(await entriesIn(s, '2026-10-01', '2026-10-31')).toEqual([entry]);
  });

  it("ignores another user's category and refuses bad input", async () => {
    const a = await signup();
    const b = await signup();
    const { bill } = await create(b, { category_id: await categoryId(a, 'Bills') });
    expect(bill.category_id).toBeNull();
    for (const body of [{}, { amount_cents: 100, description: 'x', cadence: 'daily', first_due: '2026-10-01', mode: 'ask' }, { amount_cents: 100, description: 'x', cadence: 'monthly', first_due: '2026-02-30', mode: 'ask' }]) {
      expect((await api('/api/bills', { body, cookie: a.cookie })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api('/api/bills')).status).toBe(401);
  });

  it('pays the due occurrence once and moves on; a stale second tap is refused', async () => {
    const s = await signup();
    const { bill } = await create(s);
    const pay = (due: string) => api(`/api/bills/${bill.id}/pay`, { body: { due, occurred_at: '2026-10-14T09:02' }, cookie: s.cookie });
    const res = await pay('2026-10-14');
    expect(res.status).toBe(200);
    const paid = await json<{ bill: Bill; entry: Entry }>(res);
    expect(paid.bill.next_due).toBe('2026-11-14');
    expect(paid.entry).toMatchObject({ bill_id: bill.id, amount_cents: 4_500, occurred_at: '2026-10-14T09:02' });
    expect((await pay('2026-10-14')).status).toBe(409);
    expect(await entriesIn(s, '2026-10-01', '2026-10-31')).toHaveLength(1);

    const detail = await json<BillDetail>(await api(`/api/bills/${bill.id}`, { cookie: s.cookie }));
    expect(detail.bill.next_due).toBe('2026-11-14');
    expect(detail.entries.map((e) => e.id)).toEqual([paid.entry.id]);
  });

  it('deleting the latest payment makes its occurrence due again; an older one leaves the bill', async () => {
    const s = await signup();
    const { bill } = await create(s, { first_due: '2026-11-12' });
    const pay = (due: string) => api(`/api/bills/${bill.id}/pay`, { body: { due, occurred_at: '2026-10-13T17:56' }, cookie: s.cookie }).then((r) => json<{ bill: Bill; entry: Entry }>(r));
    const nov = await pay('2026-11-12');
    const dec = await pay('2026-12-12');
    expect(dec.bill.next_due).toBe('2027-01-12');
    const del = (id: string) => api(`/api/entries/${id}`, { method: 'DELETE', cookie: s.cookie });
    const nextDue = async () => (await json<BillDetail>(await api(`/api/bills/${bill.id}`, { cookie: s.cookie }))).bill.next_due;

    // November is not the latest payment: December stays paid, and so the bill stays put.
    const again = await pay('2027-01-12');
    expect((await del(nov.entry.id)).status).toBe(204);
    expect(await nextDue()).toBe('2027-02-12');
    expect((await del(again.entry.id)).status).toBe(204);
    expect(await nextDue()).toBe('2027-01-12');
    expect((await del(dec.entry.id)).status).toBe(204);
    expect(await nextDue()).toBe('2026-12-12');
    expect(await entriesIn(s, '2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('deleting a payment logged before the paid day was kept moves the bill back one occurrence', async () => {
    const s = await signup();
    const { bill, entry } = await create(s, { first_due: '2026-10-12', paid_at: '2026-10-12T21:32' });
    const { bill: moved } = await json<{ bill: Bill }>(await api(`/api/bills/${bill.id}/skip`, { body: { due: '2026-11-12' }, cookie: s.cookie }));
    expect(moved.next_due).toBe('2026-12-12');
    await env.DB.prepare('UPDATE entries SET bill_due = NULL WHERE id = ?').bind(entry!.id).run();
    expect((await api(`/api/entries/${entry!.id}`, { method: 'DELETE', cookie: s.cookie })).status).toBe(204);
    expect((await json<BillDetail>(await api(`/api/bills/${bill.id}`, { cookie: s.cookie }))).bill.next_due).toBe('2026-11-12');
  });

  it('skips an occurrence without an entry', async () => {
    const s = await signup();
    const { bill } = await create(s);
    const res = await api(`/api/bills/${bill.id}/skip`, { body: { due: '2026-10-14' }, cookie: s.cookie });
    expect((await json<{ bill: Bill }>(res)).bill.next_due).toBe('2026-11-14');
    expect((await api(`/api/bills/${bill.id}/skip`, { body: { due: '2026-10-14' }, cookie: s.cookie })).status).toBe(409);
    expect(await entriesIn(s, '2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('sync logs automatic bills that came due, every missed one, and only once', async () => {
    const s = await signup();
    const { bill: auto } = await create(s, { description: 'Netflix', amount_cents: 1_890, first_due: '2026-08-15', mode: 'auto' });
    const { bill: asks } = await create(s, { first_due: '2026-08-14', mode: 'ask' });
    const { bill: later } = await create(s, { description: 'Spotify', first_due: '2026-10-26', mode: 'auto' });

    const sync = () => api('/api/bills/sync', { body: { today: '2026-10-15' }, cookie: s.cookie }).then((r) => json<BillsSync>(r));
    const first = await sync();
    expect(first.logged.map((e) => e.occurred_at).sort()).toEqual(['2026-08-15T09:00', '2026-09-15T09:00', '2026-10-15T09:00']);
    expect(first.logged.every((e) => e.bill_id === auto.id && e.description === 'Netflix')).toBe(true);
    const byId = new Map(first.bills.map((b) => [b.id, b]));
    expect(byId.get(auto.id)?.next_due).toBe('2026-11-15');
    expect(byId.get(asks.id)?.next_due).toBe('2026-08-14');
    expect(byId.get(later.id)?.next_due).toBe('2026-10-26');

    const again = await sync();
    expect(again.logged).toEqual([]);
    expect(await entriesIn(s, '2026-08-01', '2026-10-31')).toHaveLength(3);
  });

  it('edits a bill: a day on the beat keeps it, a new cadence or a day off it restarts it', async () => {
    const s = await signup();
    const { bill } = await create(s, { first_due: '2026-01-31' });
    const patch = (body: unknown) => api(`/api/bills/${bill.id}`, { method: 'PATCH', body, cookie: s.cookie }).then((r) => json<{ bill: Bill }>(r));
    expect((await patch({ next_due: '2026-02-28', amount_cents: 5_000, mode: 'auto' })).bill).toMatchObject({ anchor: '2026-01-31', next_due: '2026-02-28', amount_cents: 5_000, mode: 'auto' });
    expect((await patch({ next_due: '2026-03-10' })).bill).toMatchObject({ anchor: '2026-03-10', next_due: '2026-03-10' });
    expect((await patch({ cadence: 'yearly' })).bill).toMatchObject({ anchor: '2026-03-10', cadence: 'yearly' });
    expect((await api(`/api/bills/${bill.id}`, { method: 'PATCH', body: {}, cookie: s.cookie })).status).toBe(400);
  });

  it('stops a bill and keeps the entries that paid it', async () => {
    const s = await signup();
    const other = await signup();
    const { bill, entry } = await create(s, { first_due: '2026-10-01', paid_at: '2026-10-01T09:00' });
    expect((await api(`/api/bills/${bill.id}`, { method: 'DELETE', cookie: other.cookie })).status).toBe(404);
    expect((await api(`/api/bills/${bill.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await api(`/api/bills/${bill.id}`, { method: 'DELETE', cookie: s.cookie })).status).toBe(204);
    expect(await entriesIn(s, '2026-10-01', '2026-10-31')).toEqual([{ ...entry, bill_id: null }]);
    expect((await api(`/api/bills/${bill.id}`, { cookie: s.cookie })).status).toBe(404);
  });

  it('suggests habits in past entries, minus bills and dismissed ones', async () => {
    const s = await signup();
    const entries = (description: string, amount_cents: number, days: string[]): NewEntry[] =>
      days.map((d) => ({ amount_cents, description, occurred_at: `${d}T08:00`, source: 'manual' }));
    const res = await api('/api/entries', {
      body: {
        entries: [
          ...entries('Salt Home internet', 4_995, ['2026-07-20', '2026-08-20', '2026-09-21']),
          ...entries('Spotify', 1_395, ['2026-07-26', '2026-08-26', '2026-09-26']),
          ...entries('Gym', 7_900, ['2026-07-05', '2026-08-05', '2026-09-05']),
        ],
      },
      cookie: s.cookie,
    });
    expect(res.status).toBe(201);
    await create(s, { description: 'spotify', first_due: '2026-10-26' });
    expect((await api('/api/bills/suggestions/dismiss', { body: { key: patternKey('Gym', 7_900) }, cookie: s.cookie })).status).toBe(204);

    const { suggestions } = await json<{ suggestions: BillSuggestion[] }>(await api('/api/bills/suggestions?today=2026-10-12', { cookie: s.cookie }));
    expect(suggestions.map((x) => [x.description, x.cadence, x.next_due, x.seen])).toEqual([['Salt Home internet', 'monthly', '2026-10-21', ['2026-07-20', '2026-08-20', '2026-09-21']]]);
    expect((await api('/api/bills/suggestions?today=nope', { cookie: s.cookie })).status).toBe(400);
  });

  it('goes with the account', async () => {
    const s = await signup();
    await create(s);
    await api('/api/bills/suggestions/dismiss', { body: { key: 'x|1' }, cookie: s.cookie });
    expect((await api('/api/auth/account', { method: 'DELETE', body: { email: s.email }, cookie: s.cookie })).status).toBe(204);
    const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM bills WHERE user_id = ?1) AS bills, (SELECT COUNT(*) FROM bill_dismissals WHERE user_id = ?1) AS dismissed')
      .bind(s.userId)
      .first<{ bills: number; dismissed: number }>();
    expect(counts).toEqual({ bills: 0, dismissed: 0 });
  });
});
