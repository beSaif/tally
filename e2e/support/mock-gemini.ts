/**
 * Mocked Gemini REST API (docs/SPEC.md §7): `page.route('https://generativelanguage.googleapis.com/**')`.
 * Key checks (GET models/{model}), parses (fixtures shaped like §7.4's responseSchema) and the
 * plain-text "ask your data" answer.
 */
import type { Page, Route } from '@playwright/test';
import { DEFAULT_MODEL } from '../../src/shared/constants';

/** One raw entry as Gemini returns it (amount is a decimal number, not cents). */
export interface RawEntry {
  amount: number;
  currency: string;
  description: string;
  category: string;
  occurred_at: string;
  note: string | null;
  confidence: number;
}
export interface RawParse {
  transcript: string;
  entries: RawEntry[];
  reply: string | null;
}

export const VOICE_TRANSCRIPT = 'Dinner at Bains des Pâquis with Léa, forty-two francs, we split it';
export const BATCH_TEXT = 'groceries 23.40 at coop, a coffee for 4 and the train to Lausanne 22.80 half fare';
export const ASK_ANSWER = 'You spent 1 284.60 CHF. Groceries led at 32%, dining is up on September.';

/** `now` is 'YYYY-MM-DDTHH:MM' (taken from the request's "Now:" line). */
export const fixtures = {
  single: (now: string, transcript = VOICE_TRANSCRIPT): RawParse => ({
    transcript,
    entries: [
      {
        amount: 21,
        currency: 'CHF',
        description: 'Dinner, Bains des Pâquis',
        category: 'Dining',
        occurred_at: now,
        note: 'Split with Léa · 42.00 total',
        confidence: 0.93,
      },
    ],
    reply: null,
  }),
  batch: (now: string): RawParse => ({
    transcript: BATCH_TEXT,
    entries: [
      { amount: 23.4, currency: 'CHF', description: 'Coop', category: 'Groceries', occurred_at: now, note: null, confidence: 0.95 },
      { amount: 4, currency: 'CHF', description: 'Coffee', category: 'Dining', occurred_at: now, note: null, confidence: 0.9 },
      { amount: 22.8, currency: 'CHF', description: 'Train → Lausanne', category: 'Transport', occurred_at: now, note: '½ fare', confidence: 0.88 },
    ],
    reply: null,
  }),
  receipt: (now: string): RawParse => ({
    transcript: '',
    entries: [{ amount: 96.4, currency: 'CHF', description: 'Coop weekly shop', category: 'Groceries', occurred_at: now, note: 'Bread, fruit, coffee beans', confidence: 0.86 }],
    reply: null,
  }),
  empty: (text: string): RawParse => ({ transcript: text, entries: [], reply: 'I could not find an amount in that.' }),
  /** "Coffee 4.50" style: one entry from a word and a number. */
  simple: (now: string, text: string): RawParse => {
    const amount = Number((/(\d+(?:[.,]\d{1,2})?)/.exec(text)?.[1] ?? '0').replace(',', '.'));
    const words = text.replace(/[\d.,]+/g, ' ').replace(/\b(chf|eur|francs?)\b/gi, ' ').trim().replace(/\s+/g, ' ');
    const description = words ? words[0]!.toUpperCase() + words.slice(1) : 'Expense';
    const lower = text.toLowerCase();
    const category = /coffee|café|lunch|dinner|restaurant|beer/.test(lower)
      ? 'Dining'
      : /train|tpg|bus|taxi|tram/.test(lower)
        ? 'Transport'
        : /migros|coop|groceries|bakery/.test(lower)
          ? 'Groceries'
          : /cinema|concert|movie/.test(lower)
            ? 'Fun'
            : 'Other';
    return { transcript: text, entries: [{ amount, currency: 'CHF', description, category, occurred_at: now, note: null, confidence: 0.8 }], reply: null };
  },
};

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}
export interface GeminiRequest {
  systemInstruction?: { parts?: GeminiPart[] };
  contents?: Array<{ role?: string; parts?: GeminiPart[] }>;
  generationConfig?: { responseMimeType?: string };
}

export type GeminiOverride = { status: number; body: unknown } | { abort: true } | { text: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** The "Now: … YYYY-MM-DD HH:MM" line of the system instruction, else the Node clock. */
export function nowFrom(req: GeminiRequest): string {
  const system = (req.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n');
  const m = /Now:[^\n]*?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(system);
  if (m) return `${m[1]}T${m[2]}`;
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "Ask your data": answers from the context the app sent (period total and the top category of
 * the system instruction), so a test sees that the visible period's data reached Gemini.
 */
export function chooseAnswer(req: GeminiRequest, fallback: string): string {
  const system = (req.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n');
  const total = /Total: ([\d\u202f\u00a0 ]+\.\d{2}) ([A-Z]{3})/.exec(system);
  const top = /By category:\n- (.+?) ([\d\u202f\u00a0 ]+\.\d{2}) [A-Z]{3}/.exec(system);
  if (!total || !top) return fallback;
  const cents = (s: string) => Math.round(Number(s.replace(/[^\d.]/g, '')) * 100);
  const pct = Math.round((cents(top[2] ?? '0') / Math.max(1, cents(total[1] ?? '0'))) * 100);
  const french = /Answer in French/.test(system);
  return french
    ? `Vous avez dépensé ${total[1]} ${total[2]}. ${top[1]} arrive en tête avec ${pct}\u202f%.`
    : `You spent ${total[1]} ${total[2]}. ${top[1]} led at ${pct}%.`;
}

export function chooseParse(req: GeminiRequest): RawParse {
  const now = nowFrom(req);
  const parts = req.contents?.flatMap((c) => c.parts ?? []) ?? [];
  const media = parts.find((p) => p.inlineData)?.inlineData?.mimeType ?? '';
  if (media.startsWith('audio/')) return fixtures.single(now);
  if (media.startsWith('image/')) return fixtures.receipt(now);
  const text = parts.map((p) => p.text ?? '').join(' ').trim();
  const lower = text.toLowerCase();
  if (lower.includes('coop') || (lower.includes('groceries') && lower.includes('coffee'))) return fixtures.batch(now);
  if (lower.includes('dinner') && lower.includes('pâquis')) return fixtures.single(now, text);
  if (!/\d/.test(text)) return fixtures.empty(text);
  return fixtures.simple(now, text);
}

const candidate = (text: string) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 420, candidatesTokenCount: 80, totalTokenCount: 500 },
  modelVersion: DEFAULT_MODEL,
});

export class MockGemini {
  readonly requests: Array<{ url: string; method: string; key: string | null; body: GeminiRequest | null }> = [];
  /** Responses used, in order, before the fixtures (errors, odd payloads). */
  readonly overrides: GeminiOverride[] = [];
  /** A fixed "ask your data" answer; null answers from the request's context (chooseAnswer). */
  answer: string | null = null;
  private held: Array<() => void> | null = null;

  async install(page: Page): Promise<void> {
    await page.route('https://generativelanguage.googleapis.com/**', (route) => this.handle(route));
  }

  /** Holds every generate request until `release()` (to look at the "thinking" state). */
  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const waiting = this.held ?? [];
    this.held = null;
    for (const go of waiting) go();
  }

  failNext(status: number, message = 'error', reason?: string): void {
    this.overrides.push({ status, body: { error: { code: status, message, status: 'ERROR', ...(reason ? { details: [{ reason }] } : {}) } } });
  }

  /** The next generate request never reaches Google (no connection). */
  dropNext(): void {
    this.overrides.push({ abort: true });
  }

  /** The next generate request is answered with this model text (e.g. something that is not JSON). */
  answerNext(text: string): void {
    this.overrides.push({ text });
  }

  /** Bodies of the generate requests so far (parse and ask). */
  get generateBodies(): GeminiRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.body).map((r) => r.body as GeminiRequest);
  }

  get generateCalls(): number {
    return this.requests.filter((r) => r.method === 'POST').length;
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const key = req.headers()['x-goog-api-key'] ?? url.searchParams.get('key');
    let body: GeminiRequest | null = null;
    try {
      body = req.postDataJSON() as GeminiRequest | null;
    } catch {
      body = null;
    }
    this.requests.push({ url: req.url(), method: req.method(), key, body });

    if (req.method() === 'GET') {
      const model = decodeURIComponent(url.pathname.split('/models/')[1] ?? '');
      if (!key || /bad|invalid|wrong/i.test(key)) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }),
        });
      }
      if (/nope|missing/.test(model)) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 404, message: `models/${model} is not found`, status: 'NOT_FOUND' } }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: `models/${model}`, displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }),
      });
    }

    if (this.held) await new Promise<void>((resolve) => this.held?.push(resolve) ?? resolve());

    const override = this.overrides.shift();
    if (override && 'abort' in override) return route.abort('internetdisconnected');
    if (override && 'text' in override) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(candidate(override.text)) });
    if (override) return route.fulfill({ status: override.status, contentType: 'application/json', body: JSON.stringify(override.body) });

    if (body?.generationConfig?.responseMimeType === 'text/plain') {
      const text = this.answer ?? chooseAnswer(body, ASK_ANSWER);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(candidate(text)) });
    }
    const parse = body ? chooseParse(body) : fixtures.empty('');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(candidate(JSON.stringify(parse))) });
  }
}
