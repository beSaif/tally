import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiError, askData, buildAskSystemInstruction, type AskContext, type GenerateContentRequest } from '@app/lib/gemini';
import { NNBSP } from '@shared/money';

const KEY = 'AIzaSyTEST_key-0123456789abcdefghijklm';
const CFG = { apiKey: KEY, model: 'gemini-2.5-flash' };
const GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const CTX: AskContext = {
  now: new Date(2026, 9, 5, 14, 30), // local time; a Monday
  timeZone: 'Europe/Zurich',
  currency: 'CHF',
  language: 'en',
  categories: ['Groceries', 'Dining'],
  periodLabel: 'October 2026',
  from: '2026-10-01',
  to: '2026-10-31',
  totalCents: 128460,
  byCategory: [
    { name: 'Groceries', totalCents: 41230 },
    { name: 'Dining', totalCents: 2100 },
    { name: 'Other', totalCents: 450 },
  ],
  // Deliberately not newest-first: the instruction must sort them.
  entries: [
    { occurred_at: '2026-10-03T09:15', amount_cents: 41230, currency: 'CHF', description: 'Migros', category: 'Groceries', note: null },
    { occurred_at: '2026-10-05T12:40', amount_cents: 2100, currency: 'CHF', description: 'Lunch', category: 'Dining', note: 'split with Anna, total 42.00' },
    { occurred_at: '2026-10-04T08:05', amount_cents: 450, currency: 'EUR', description: 'Coffee\nto go', category: null, note: '' },
  ],
};

const EXPECTED_INSTRUCTION = [
  `You answer questions about a person's expenses. Answer in English in one or two short sentences with exact amounts in CHF (format 1${NNBSP}284.60). Only use the data below. If the data cannot answer, say so.`,
  'Now: Monday 2026-10-05 14:30 (Europe/Zurich).',
  `Period: October 2026 (2026-10-01..2026-10-31). Total: 1${NNBSP}284.60 CHF.`,
  'By category:',
  '- Groceries 412.30 CHF',
  '- Dining 21.00 CHF',
  '- Other 4.50 CHF',
  'Entries (date time amount category description | note):',
  '2026-10-05 12:40 · 21.00 CHF · Dining · Lunch | split with Anna, total 42.00',
  '2026-10-04 08:05 · 4.50 EUR · Other · Coffee to go',
  '2026-10-03 09:15 · 412.30 CHF · Groceries · Migros',
].join('\n');

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function geminiText(text: string): Response {
  return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
}

function mockFetch(...replies: Array<Response | Error>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected fetch call');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof mockFetch>, index = 0): GenerateContentRequest {
  const init = fetchMock.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as GenerateContentRequest;
}

async function failure(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GeminiError) return err;
    throw err;
  }
  throw new Error('expected a GeminiError');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** n entries one minute apart from 2026-10-01T00:00, oldest first. */
function manyEntries(n: number): AskContext['entries'] {
  return Array.from({ length: n }, (_, i) => ({
    occurred_at: `2026-10-01T${pad(Math.floor(i / 60))}:${pad(i % 60)}`,
    amount_cents: 100 + i,
    currency: 'CHF',
    description: `Item ${i}`,
    category: null,
    note: null,
  }));
}

function entryLines(instruction: string): string[] {
  const lines = instruction.split('\n');
  return lines.slice(lines.indexOf('Entries (date time amount category description | note):') + 1);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('askData', () => {
  it('posts the §7.5 body and returns the trimmed answer', async () => {
    const fetchMock = mockFetch(geminiText(`  You spent 21.00 CHF on dining this month.\n`));
    const answer = await askData(CFG, '  How much on dining? ', CTX);
    expect(answer).toBe('You spent 21.00 CHF on dining this month.');

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe(GENERATE_URL);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-goog-api-key')).toBe(KEY);
    expect(headers.get('content-type')).toBe('application/json');
    expect(bodyOf(fetchMock)).toEqual({
      systemInstruction: { parts: [{ text: EXPECTED_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: 'How much on dining?' }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'text/plain', thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('retries once without thinkingConfig when the model refuses it', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ error: { code: 400, message: 'Thinking is not supported by this model.', status: 'INVALID_ARGUMENT' } }, 400),
      geminiText('About 21.00 CHF.'),
    );
    await expect(askData(CFG, 'Dining?', CTX)).resolves.toBe('About 21.00 CHF.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1).generationConfig).toEqual({ temperature: 0.3, responseMimeType: 'text/plain' });
  });

  it('maps errors like parseExpenses', async () => {
    mockFetch(jsonResponse({ error: { code: 429, message: 'Quota exceeded.' } }, 429));
    expect(await failure(askData(CFG, 'Dining?', CTX))).toMatchObject({ code: 'quota', status: 429 });
    mockFetch(geminiText('   '));
    expect((await failure(askData(CFG, 'Dining?', CTX))).code).toBe('bad_response');
    mockFetch(new TypeError('Failed to fetch'));
    expect((await failure(askData(CFG, 'Dining?', CTX))).code).toBe('network');
    const controller = new AbortController();
    controller.abort();
    const fetchMock = mockFetch();
    expect((await failure(askData(CFG, 'Dining?', CTX, { signal: controller.signal }))).code).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildAskSystemInstruction', () => {
  it('sends at most 400 entries, newest first, and says how many were left out', () => {
    const lines = entryLines(buildAskSystemInstruction({ ...CTX, entries: manyEntries(405) }));
    expect(lines).toHaveLength(401);
    expect(lines[0]).toBe('2026-10-01 06:44 · 5.04 CHF · Other · Item 404');
    expect(lines[399]).toBe('2026-10-01 00:05 · 1.05 CHF · Other · Item 5');
    expect(lines[400]).toBe('…and 5 more');
  });

  it('sends exactly 400 entries without a remainder line', () => {
    const lines = entryLines(buildAskSystemInstruction({ ...CTX, entries: manyEntries(400) }));
    expect(lines).toHaveLength(400);
    expect(lines.some((line) => line.startsWith('…'))).toBe(false);
  });

  it('speaks French when the person does', () => {
    const text = buildAskSystemInstruction({ ...CTX, language: 'fr', entries: manyEntries(402) });
    expect(text).toContain('Answer in French in one or two short sentences');
    expect(text).toContain('2026-10-01 06:41 · 5.01 CHF · Autre · Item 401');
    expect(text.endsWith('\n…et 2 de plus')).toBe(true);
  });

  it('says when there is nothing to look at', () => {
    const text = buildAskSystemInstruction({ ...CTX, totalCents: 0, byCategory: [], entries: [] });
    expect(text.split('\n').slice(2)).toEqual([
      'Period: October 2026 (2026-10-01..2026-10-31). Total: 0.00 CHF.',
      'By category:',
      '(none)',
      'Entries (date time amount category description | note):',
      '(none)',
    ]);
  });
});
