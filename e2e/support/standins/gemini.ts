/**
 * Stand-in for src/app/lib/gemini.ts, used ONLY by the visual-test dev server
 * (e2e/support/vite.visual.config.ts) while the real module is still a stub. It speaks the same
 * REST protocol (spec §7.1) so e2e/support/mock-gemini.ts fixtures are exercised either way.
 */
import { geminiParseSchema } from '@shared/schemas';

export type GeminiConfig = { apiKey: string; model: string };
export type Lang = 'en' | 'fr';
export type ParseContext = { now: Date; timeZone: string; currency: string; language: Lang; categories: string[] };
export type ParsedEntry = {
  amount_cents: number;
  currency: string;
  description: string;
  category: string | null;
  occurred_at: string;
  note: string | null;
  confidence: number;
};
export type ParseResult = { transcript: string; entries: ParsedEntry[]; reply: string | null };
export type ParseInput = { kind: 'text'; text: string } | { kind: 'audio'; blob: Blob } | { kind: 'image'; blob: Blob };
export type AskContext = ParseContext & {
  periodLabel: string;
  from: string;
  to: string;
  totalCents: number;
  byCategory: Array<{ name: string; totalCents: number }>;
  entries: Array<{ occurred_at: string; amount_cents: number; currency: string; description: string; category: string | null; note: string | null }>;
};
export type GeminiErrorCode = 'invalid_key' | 'model_not_found' | 'quota' | 'network' | 'bad_response' | 'unknown' | 'aborted';
export type KeyCheck = { ok: true; model: string } | { ok: false; code: GeminiErrorCode; message: string };

export class GeminiError extends Error {
  readonly code: GeminiErrorCode;
  readonly status?: number;
  constructor(code: GeminiErrorCode, message?: string, status?: number) {
    super(message ?? code);
    this.name = 'GeminiError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const pad = (n: number) => String(n).padStart(2, '0');

function codeFor(status: number, body: string): GeminiErrorCode {
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) return 'invalid_key';
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'quota';
  return 'unknown';
}

export async function checkKey(cfg: GeminiConfig, opts?: { signal?: AbortSignal }): Promise<KeyCheck> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(cfg.model)}`, { headers: { 'x-goog-api-key': cfg.apiKey }, signal: opts?.signal });
    if (res.ok) return { ok: true, model: cfg.model };
    return { ok: false, code: codeFor(res.status, await res.text()), message: `HTTP ${res.status}` };
  } catch (err) {
    if (opts?.signal?.aborted) return { ok: false, code: 'aborted', message: 'aborted' };
    return { ok: false, code: 'network', message: String(err) };
  }
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function nowLine(ctx: ParseContext): string {
  const d = ctx.now;
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  return `Now: ${weekday} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${ctx.timeZone}). Currency: ${ctx.currency}. The person's language: ${ctx.language}.`;
}

async function generate(cfg: GeminiConfig, body: unknown, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new GeminiError('aborted');
    throw new GeminiError('network', String(err));
  }
  const text = await res.text();
  if (!res.ok) throw new GeminiError(codeFor(res.status, text), text, res.status);
  try {
    const json = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  } catch {
    throw new GeminiError('bad_response');
  }
}

export async function parseExpenses(cfg: GeminiConfig, input: ParseInput, ctx: ParseContext, opts?: { signal?: AbortSignal }): Promise<ParseResult> {
  const parts =
    input.kind === 'text'
      ? [{ text: input.text }]
      : input.kind === 'audio'
        ? [{ inlineData: { mimeType: input.blob.type || 'audio/wav', data: await base64(input.blob) } }, { text: 'Transcribe and extract the expenses.' }]
        : [{ inlineData: { mimeType: 'image/jpeg', data: await base64(input.blob) } }, { text: 'This is a receipt. Extract the expense(s).' }];
  const system = `You turn what a person typed, said, or photographed into expense entries.\n${nowLine(ctx)}\nCategories (use exactly one of these names, or "Other"): ${ctx.categories.join(', ')}.`;
  const out = await generate(
    cfg,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    },
    opts?.signal,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
  } catch {
    throw new GeminiError('bad_response');
  }
  const parsed = geminiParseSchema.safeParse(raw);
  if (!parsed.success) throw new GeminiError('bad_response');
  return {
    transcript: parsed.data.transcript,
    reply: parsed.data.reply,
    entries: parsed.data.entries.map((e) => ({
      amount_cents: Math.round(e.amount * 100),
      currency: e.currency || ctx.currency,
      description: e.description,
      category: e.category && e.category.toLowerCase() !== 'other' ? e.category : null,
      occurred_at: e.occurred_at,
      note: e.note,
      confidence: e.confidence,
    })),
  };
}

export async function askData(cfg: GeminiConfig, question: string, ctx: AskContext, opts?: { signal?: AbortSignal }): Promise<string> {
  const lines = ctx.entries.slice(0, 400).map((e) => `${e.occurred_at} ${(e.amount_cents / 100).toFixed(2)} ${e.category ?? 'Other'} ${e.description}${e.note ? ` | ${e.note}` : ''}`);
  const system = `You answer questions about a person's expenses. Answer in ${ctx.language}. Period: ${ctx.periodLabel} (${ctx.from}..${ctx.to}). Total: ${(ctx.totalCents / 100).toFixed(2)}.\n${lines.join('\n')}`;
  return generate(
    cfg,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: question }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'text/plain' },
    },
    opts?.signal,
  );
}
