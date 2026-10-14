import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Bill, Entry, NewEntry, Summary } from '@shared/api';
import { api, signup, type Session } from './helpers';
import { fxStub } from './fx-stub';

// Test rates (fx-stub.ts), units per euro: CHF 0.9, USD 1.2, GBP 0.8, JPY 160.

const entry = (over: Partial<NewEntry> = {}): NewEntry => ({ amount_cents: 1000, description: 'Ticket', occurred_at: '2026-10-05T12:00', source: 'text', ...over });

async function create(s: Session, entries: NewEntry[]): Promise<Entry[]> {
  const res = await api('/api/entries', { body: { entries }, cookie: s.cookie });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function list(s: Session, from = '2026-10-01', to = '2026-10-31'): Promise<Entry[]> {
  const res = await api(`/api/entries?from=${from}&to=${to}`, { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

async function total(s: Session, from = '2026-10-01', to = '2026-10-31'): Promise<number> {
  const res = await api(`/api/summary?from=${from}&to=${to}`, { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as Summary).total_cents;
}

async function setCurrency(s: Session, currency: string): Promise<void> {
  expect((await api('/api/settings', { method: 'PUT', body: { currency }, cookie: s.cookie })).status).toBe(200);
}

beforeEach(async () => {
  fxStub.reset();
  // The rates are shared by every account: start each test with none kept.
  await env.DB.prepare('DELETE FROM fx_rates').run();
});

describe('amounts in another currency', () => {
  it('count in the person’s currency at the rate of their day', async () => {
    const s = await signup(); // CHF
    const [chf, eur, usd, jpy] = await create(s, [
      entry({ amount_cents: 1865 }),
      entry({ amount_cents: 1760, currency: 'EUR' }),
      entry({ amount_cents: 1200, currency: 'USD', occurred_at: '2026-10-06T09:00' }),
      entry({ amount_cents: 160_000, currency: 'JPY' }),
    ]);
    expect(chf!.home_cents).toBe(1865);
    expect(eur!.home_cents).toBe(1584); // 17.60 € × 0.9
    expect(usd!.home_cents).toBe(900); // 12.00 $ ÷ 1.2 × 0.9
    expect(jpy!.home_cents).toBe(900); // 1600 ¥ ÷ 160 × 0.9
    expect(eur!.amount_cents).toBe(1760);
    expect(eur!.currency).toBe('EUR');
    // One request per day, whatever the currencies.
    expect(fxStub.days.sort()).toEqual(['2026-10-05', '2026-10-06']);
    expect(await total(s)).toBe(1865 + 1584 + 900 + 900);
  });

  it('asks for a day’s rates once, and never for the person’s own currency', async () => {
    const s = await signup();
    await create(s, [entry()]);
    expect(fxStub.days).toEqual([]);
    await create(s, [entry({ currency: 'EUR' })]);
    await create(s, [entry({ currency: 'GBP', occurred_at: '2026-10-05T20:00' })]);
    expect(fxStub.days).toEqual(['2026-10-05']);
  });

  it('uses today’s rates for a day still to come', async () => {
    const s = await signup();
    const [e] = await create(s, [entry({ currency: 'EUR', occurred_at: '2999-01-01T10:00' })]);
    expect(e!.home_cents).toBe(900);
    expect(fxStub.days).toEqual([new Date().toISOString().slice(0, 10)]);
  });

  it('counts the amount as it is while the rate service is down, and fills it in on the next read', async () => {
    const s = await signup();
    fxStub.down = true;
    const [e] = await create(s, [entry({ amount_cents: 2000, currency: 'EUR' }), entry({ amount_cents: 500 })]);
    expect(e!.home_cents).toBeNull();
    expect(await total(s)).toBe(2500);

    fxStub.down = false;
    expect(await total(s)).toBe(1800 + 500);
    expect((await list(s)).find((x) => x.id === e!.id)?.home_cents).toBe(1800);
  });

  it('fills in an entry whose day got its rates through someone else’s request', async () => {
    const s = await signup();
    fxStub.down = true;
    const [e] = await create(s, [entry({ amount_cents: 2000, currency: 'EUR' })]);
    expect(e!.home_cents).toBeNull();

    fxStub.down = false;
    await create(await signup(), [entry({ currency: 'USD' })]);
    expect(fxStub.days).toEqual(['2026-10-05', '2026-10-05']);
    expect((await list(s))[0]?.home_cents).toBe(1800);
    expect(fxStub.days).toHaveLength(2);
  });

  it('leaves a currency the rates do not know as it is, without asking again on every read', async () => {
    const s = await signup();
    const [e] = await create(s, [entry({ amount_cents: 700, currency: 'XTS' })]);
    expect(e!.home_cents).toBeNull();
    expect(await total(s)).toBe(700);
    expect(await list(s)).toHaveLength(1);
    expect(fxStub.days).toEqual(['2026-10-05']);
  });

  it('follows edits of the amount, currency and day', async () => {
    const s = await signup();
    const [e] = await create(s, [entry({ amount_cents: 1000 })]);
    const edit = async (body: unknown) => ((await (await api(`/api/entries/${e!.id}`, { method: 'PATCH', body, cookie: s.cookie })).json()) as { entry: Entry }).entry;
    expect((await edit({ currency: 'EUR' })).home_cents).toBe(900);
    expect((await edit({ amount_cents: 2000 })).home_cents).toBe(1800);
    expect(fxStub.days).toEqual(['2026-10-05']);
    expect((await edit({ occurred_at: '2026-09-30T12:00' })).home_cents).toBe(1800);
    expect(fxStub.days).toEqual(['2026-10-05', '2026-09-30']);
    expect((await edit({ currency: 'CHF' })).home_cents).toBe(2000);
    expect((await edit({ description: 'Train' })).home_cents).toBe(2000);
  });

  it('count again in the new currency when the person changes theirs', async () => {
    const s = await signup();
    await create(s, [entry({ amount_cents: 900 }), entry({ amount_cents: 1000, currency: 'EUR' })]);
    expect(await total(s)).toBe(900 + 900);

    await setCurrency(s, 'EUR');
    expect((await list(s)).map((e) => [e.currency, e.home_cents]).sort()).toEqual([
      ['CHF', 1000],
      ['EUR', 1000],
    ]);
    expect(await total(s)).toBe(2000);
    await setCurrency(s, 'CHF');
    expect(await total(s)).toBe(1800);
  });

  it('applies to bill payments', async () => {
    const s = await signup();
    const res = await api('/api/bills', {
      body: { amount_cents: 2500, currency: 'EUR', description: 'Phone', cadence: 'monthly', first_due: '2026-10-12', mode: 'ask', paid_at: '2026-10-12T21:32' },
      cookie: s.cookie,
    });
    expect(res.status).toBe(201);
    const { bill, entry: first } = (await res.json()) as { bill: Bill; entry: Entry };
    expect(first.home_cents).toBe(2250);

    const pay = await api(`/api/bills/${bill.id}/pay`, { body: { due: bill.next_due }, cookie: s.cookie });
    expect(pay.status).toBe(200);
    expect(((await pay.json()) as { entry: Entry }).entry.home_cents).toBe(2250);
  });
});
