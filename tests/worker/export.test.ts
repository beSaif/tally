import { describe, expect, it } from 'vitest';
import type { ApiErrorBody, Entry, NewEntry } from '@shared/api';
import { csvField, csvLine, csvText, entriesCsv, plainAmount } from '../../src/worker/lib/csv';
import { api, signup, type Session } from './helpers';

const HEADER = 'date,time,amount,currency,description,category,note,source,id';
const CRLF = '\r\n';

async function createEntries(s: Session, entries: Array<Partial<NewEntry>>): Promise<Entry[]> {
  const full = entries.map((e) => ({ amount_cents: 100, description: 'x', occurred_at: '2026-10-05T12:00', source: 'manual', ...e }));
  const res = await api('/api/entries', { body: { entries: full }, cookie: s.cookie });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

/** The body as sent: Response.text() would silently drop the BOM we want to see. Throws on invalid UTF-8. */
async function rawText(res: Response): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
}

async function exportCsv(s: Session, from: string, to: string): Promise<string> {
  const res = await api(`/api/export.csv?from=${from}&to=${to}`, { cookie: s.cookie });
  expect(res.status).toBe(200);
  return (await rawText(res)).text;
}

async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return ((await res.json()) as ApiErrorBody).error;
}

describe('CSV helpers', () => {
  it('quotes only what RFC 4180 requires', () => {
    expect(csvField('Migros')).toBe('Migros');
    expect(csvField('')).toBe('');
    expect(csvField(' spaced ')).toBe(' spaced ');
    expect(csvField('Café Ünïcode')).toBe('Café Ünïcode');
    expect(csvField('Dinner, Bains des Pâquis')).toBe('"Dinner, Bains des Pâquis"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('"')).toBe('""""');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('carriage\rreturn')).toBe('"carriage\rreturn"');
    expect(csvLine(['a', 'b,c', '', 'd"e'])).toBe('a,"b,c",,"d""e"');
  });

  it('writes amounts as plain two-decimal numbers', () => {
    expect(plainAmount(0)).toBe('0.00');
    expect(plainAmount(5)).toBe('0.05');
    expect(plainAmount(1250)).toBe('12.50');
    expect(plainAmount(100_000)).toBe('1000.00');
    expect(plainAmount(123_456_789)).toBe('1234567.89');
    expect(plainAmount(1_000_000_000)).toBe('10000000.00');
    expect(plainAmount(-1250)).toBe('-12.50');
  });

  it('neutralises spreadsheet formulas in user-written text', () => {
    expect(csvText('=HYPERLINK("http://x")')).toBe("'=HYPERLINK(\"http://x\")");
    expect(csvText('+1')).toBe("'+1");
    expect(csvText('-5 francs')).toBe("'-5 francs");
    expect(csvText('@user')).toBe("'@user");
    expect(csvText('\tx')).toBe("'\tx");
    expect(csvText('Coffee')).toBe('Coffee');
    const csv = entriesCsv([
      { id: 'i', amount_cents: 100, currency: 'CHF', description: '=cmd', category_id: null, category_name: null, occurred_at: '2026-10-05T12:00', note: '@n', source: 'manual', created_at: 0, updated_at: 0 },
    ]);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'@n");
  });

  it('writes a BOM and the header even with no entries', () => {
    expect(entriesCsv([])).toBe(`﻿${HEADER}${CRLF}`);
  });
});

describe('GET /api/export.csv', () => {
  it('requires a session', async () => {
    const res = await api('/api/export.csv?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('unauthorized');
  });

  it('downloads the range as a UTF-8 CSV, oldest first', async () => {
    const s = await signup();
    const created = await createEntries(s, [
      { occurred_at: '2026-10-04T23:59', category: 'Home', amount_cents: 123_456_789, description: 'Sofa', note: 'carriage\rreturn', source: 'photo' },
      { occurred_at: '2026-10-01T08:05', category: 'Groceries', amount_cents: 1250, description: 'Migros', source: 'text' },
      {
        occurred_at: '2026-10-02T12:30',
        category: 'Dining',
        amount_cents: 4200,
        description: 'Dinner, Bains des Pâquis',
        note: 'Split with "Sam", total 84.00',
        source: 'voice',
      },
      { occurred_at: '2026-10-03T07:00', amount_cents: 5, currency: 'EUR', description: 'Gum', note: 'line one\nline two' },
      { occurred_at: '2026-10-31T23:59', amount_cents: 0, description: 'Free sample' },
      { occurred_at: '2026-09-30T23:59', description: 'September' },
      { occurred_at: '2026-11-01T00:00', description: 'November' },
    ]);
    const [sofa, migros, dinner, gum, sample] = created.map((e) => e.id);

    const res = await api('/api/export.csv?from=2026-10-01&to=2026-10-31', { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="tally-2026-10-01_2026-10-31.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const { bytes, text } = await rawText(res);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe(
      '﻿' +
        [
          HEADER,
          `2026-10-01,08:05,12.50,CHF,Migros,Groceries,,text,${migros}`,
          `2026-10-02,12:30,42.00,CHF,"Dinner, Bains des Pâquis",Dining,"Split with ""Sam"", total 84.00",voice,${dinner}`,
          `2026-10-03,07:00,0.05,EUR,Gum,,"line one\nline two",manual,${gum}`,
          `2026-10-04,23:59,1234567.89,CHF,Sofa,Home,"carriage\rreturn",photo,${sofa}`,
          `2026-10-31,23:59,0.00,CHF,Free sample,,,manual,${sample}`,
        ].join(CRLF) +
        CRLF,
    );
  });

  it('names the file after the range and handles an empty one', async () => {
    const s = await signup();
    const res = await api('/api/export.csv?from=2026-01-01&to=2026-12-31', { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="tally-2026-01-01_2026-12-31.csv"');
    expect((await rawText(res)).text).toBe(`﻿${HEADER}${CRLF}`);
  });

  it('validates the range', async () => {
    const s = await signup();
    for (const query of ['', '?from=2026-10-01', '?from=2026-10-31&to=2026-10-01', '?from=2025-01-01&to=2026-01-02', '?from=2026-13-01&to=2026-12-31']) {
      const res = await api(`/api/export.csv${query}`, { cookie: s.cookie });
      expect(res.status, query).toBe(400);
      expect((await errorOf(res)).code).toBe('validation');
    }
  });

  it("never includes another user's entries", async () => {
    const a = await signup();
    const b = await signup();
    const [mine] = await createEntries(a, [{ description: 'A secret', category: 'Health' }]);
    await createEntries(b, [{ description: 'B lunch' }]);

    const aCsv = await exportCsv(a, '2026-10-01', '2026-10-31');
    expect(aCsv).toContain(mine!.id);
    expect(aCsv).not.toContain('B lunch');
    const bCsv = await exportCsv(b, '2026-10-01', '2026-10-31');
    expect(bCsv).not.toContain('A secret');
    expect(bCsv).not.toContain(mine!.id);
    expect(bCsv.split(CRLF).filter(Boolean)).toHaveLength(2);
  });
});
