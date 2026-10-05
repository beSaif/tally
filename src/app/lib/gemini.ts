/**
 * Gemini client — browser side. Frozen interface, see docs/SPEC.md §7.6.
 * TODO(gemini-agent): implement. The frontend builds against these signatures.
 */

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

export async function checkKey(_cfg: GeminiConfig, _opts?: { signal?: AbortSignal }): Promise<KeyCheck> {
  throw new GeminiError('unknown', 'not implemented');
}

export async function parseExpenses(
  _cfg: GeminiConfig,
  _input: ParseInput,
  _ctx: ParseContext,
  _opts?: { signal?: AbortSignal },
): Promise<ParseResult> {
  throw new GeminiError('unknown', 'not implemented');
}

export async function askData(_cfg: GeminiConfig, _question: string, _ctx: AskContext, _opts?: { signal?: AbortSignal }): Promise<string> {
  throw new GeminiError('unknown', 'not implemented');
}
