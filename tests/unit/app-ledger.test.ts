/**
 * The home list's months (src/app/lib/ledger.ts, spec §3.3): a saved entry lands in the loaded
 * month that holds its day, and one outside the loaded months is never lost. After the month has
 * turned the new month is loaded on top of the others; for an older month "SHOW …" leads there.
 * The API is a small fake over a list of entries, and the clock is pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@shared/api';
import type { MonthBlock } from '@app/lib/ledger';

let server: Entry[];
let seq: number;

function entry(occurred_at: string, amount_cents = 100): Entry {
  seq++;
  return { id: `e${seq}`, amount_cents, currency: 'CHF', description: `entry ${seq}`, category_id: null, category_name: null, occurred_at, note: null, source: 'text', created_at: seq, updated_at: seq };
}

function block(key: string, from: string, to: string, entries: Entry[] = []): MonthBlock {
  return { key, from, to, entries, status: 'ready' };
}

/** A fresh ledger for an account created on `createdAt` (local time). */
async function load(createdAt = new Date(2026, 9, 2, 9, 0)) {
  vi.resetModules();
  const ledger = await import('@app/lib/ledger');
  const { user } = await import('@app/lib/store');
  user.value = { id: 'u1', email: 'lea@example.com', created_at: createdAt.getTime() };
  return ledger;
}

const keys = (blocks: readonly MonthBlock[]) => blocks.map((b) => b.key);
const ids = (b: MonthBlock | undefined) => b?.entries.map((e) => e.id);

beforeEach(() => {
  // Only the clock and timeouts: the fake API's responses still resolve on their own.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(2026, 9, 5, 20, 14));
  vi.stubGlobal('document', { documentElement: {} });
  server = [];
  seq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'https://tally.test');
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const entries = server.filter((e) => e.occurred_at.slice(0, 10) >= from && e.occurred_at.slice(0, 10) <= to);
      return new Response(JSON.stringify({ entries }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('placeEntries', () => {
  it('puts each entry in the loaded month that holds its day, newest first, and drops its earlier copy', async () => {
    const { placeEntries } = await load();
    const edited = entry('2026-10-03T08:00');
    const older = entry('2026-09-10T08:00');
    const today = entry('2026-10-05T20:14', 450);
    const list = [block('2026-10', '2026-10-01', '2026-10-31', [edited]), block('2026-09', '2026-09-01', '2026-09-30', [older])];
    // The edit moved the first entry into September.
    const placed = placeEntries(list, [{ ...edited, occurred_at: '2026-09-29T12:00' }, today]);
    expect(ids(placed.list[0])).toEqual([today.id]);
    expect(ids(placed.list[1])).toEqual([edited.id, older.id]);
    expect(placed).toMatchObject({ newer: false, oldest: null });
  });

  it('reports entries newer or older than every loaded month instead of dropping them', async () => {
    const { placeEntries } = await load();
    const october = block('2026-10', '2026-10-01', '2026-10-31');
    const placed = placeEntries([october], [entry('2026-11-01T00:10'), entry('2026-08-20T12:00'), entry('2026-07-15T12:00')]);
    expect(placed).toEqual({ list: [october], newer: true, oldest: '2026-07-15' });
  });
});

describe('a saved entry outside the loaded months', () => {
  it('is reached by "SHOW …" even when the account and the current month are new and empty', async () => {
    const ledger = await load(new Date(2026, 9, 2, 9, 0));
    await ledger.loadCurrentMonth();
    expect(ledger.months.value).toMatchObject([{ key: '2026-10', status: 'ready', entries: [] }]);
    expect(ledger.nextOlderMonth.value).toBeNull();

    const july = entry('2026-07-15T12:00', 4200);
    server.push(july);
    ledger.addEntries([july]);
    // Not this month's: the hero total stays as it was.
    expect(ledger.months.value[0]?.entries).toEqual([]);
    for (const month of ['2026-09-01', '2026-08-01', '2026-07-01']) {
      expect(ledger.nextOlderMonth.value).toBe(month);
      await ledger.loadOlderMonth();
    }
    expect(keys(ledger.months.value)).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(ids(ledger.months.value[3])).toEqual([july.id]);
    // From there on, the usual rule: one more month while the last one has entries.
    expect(ledger.nextOlderMonth.value).toBe('2026-06-01');
    await ledger.loadOlderMonth();
    expect(ledger.nextOlderMonth.value).toBeNull();
  });

  it('moved to an older month by an edit, leaves this month and is reached by "SHOW …"', async () => {
    const ledger = await load();
    const coffee = entry('2026-10-05T09:12', 450);
    server.push(coffee);
    await ledger.loadCurrentMonth();
    expect(ids(ledger.months.value[0])).toEqual([coffee.id]);

    const moved = { ...coffee, occurred_at: '2026-09-30T09:12' };
    server.splice(0, 1, moved);
    ledger.replaceEntry(moved);
    expect(ledger.months.value[0]?.entries).toEqual([]);
    expect(ledger.nextOlderMonth.value).toBe('2026-09-01');
    await ledger.loadOlderMonth();
    expect(ids(ledger.months.value[1])).toEqual([coffee.id]);
  });

  it('after the month has turned, shows the new month on top and keeps the months already loaded', async () => {
    vi.setSystemTime(new Date(2026, 9, 31, 23, 50));
    const ledger = await load();
    const october = entry('2026-10-31T23:40', 1200);
    const september = entry('2026-09-12T09:00', 6400);
    server.push(october, september);
    await ledger.loadCurrentMonth();
    await ledger.loadOlderMonth();
    expect(keys(ledger.months.value)).toEqual(['2026-10', '2026-09']);

    vi.setSystemTime(new Date(2026, 10, 1, 0, 10));
    const saved = entry('2026-11-01T00:05', 380);
    const fromAnotherDevice = entry('2026-11-01T00:01', 500);
    server.push(saved, fromAnotherDevice);
    ledger.addEntries([saved]);
    // At once: November on top with the saved entry, so the hero counts November only.
    expect(keys(ledger.months.value)).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(ids(ledger.months.value[0])).toEqual([saved.id]);
    // Then November's load brings the rest from the server.
    await vi.waitFor(() => expect(ledger.months.value[0]?.status).toBe('ready'));
    expect(ids(ledger.months.value[0])).toEqual([saved.id, fromAnotherDevice.id]);
    expect(ids(ledger.months.value[1])).toEqual([october.id]);
    expect(ids(ledger.months.value[2])).toEqual([september.id]);
  });

  it('in a future month, waits for its month without reloading anything', async () => {
    const ledger = await load();
    await ledger.loadCurrentMonth();
    const requests = vi.mocked(fetch).mock.calls.length;
    ledger.addEntries([entry('2026-12-24T19:00', 8000)]);
    expect(ledger.months.value).toMatchObject([{ key: '2026-10', entries: [] }]);
    expect(vi.mocked(fetch).mock.calls.length).toBe(requests);
  });
});

describe('loadCurrentMonth', () => {
  it('starts over when the current month does not follow the loaded ones', async () => {
    const ledger = await load();
    await ledger.loadCurrentMonth();
    await ledger.loadOlderMonth();
    vi.setSystemTime(new Date(2027, 0, 10, 12, 0));
    await ledger.loadCurrentMonth();
    expect(keys(ledger.months.value)).toEqual(['2027-01']);
  });
});
