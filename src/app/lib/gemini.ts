/**
 * Gemini client, browser side (docs/SPEC.md §7; the exported interface is frozen by §7.6).
 *
 * - The API key only ever travels to Google, in the `x-goog-api-key` header. It is never logged and
 *   is scrubbed from every error message, because messages end up on screen and in bug reports.
 * - parseExpenses prepares media itself (audio → 16 kHz mono WAV, photo → JPEG ≤ 1600 px), so the
 *   caller may pass the raw recording or the picked file; blobs that are already prepared are sent as is.
 * - Every failure surfaces as a GeminiError: the UI localises `code`; `message` is a short English
 *   explanation (the API's own wording when it gave one).
 */
import { DEFAULT_MODEL } from '@shared/constants';
import { isValidMinute, toLocalMinute } from '@shared/dates';
import { formatAmount } from '@shared/money';
import { geminiParseSchema, type GeminiParseRaw } from '@shared/schemas';
import { blobToWav16k } from './audio';
import { downscaleToJpeg, isDownscaledJpeg } from './image';

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

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** §7.3: receipts go out as JPEG, longest side 1600 px, quality 0.85. */
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.85;
/** §7.5: entry lines sent along with a question; the rest is summarised as "…and N more". */
export const ASK_MAX_ENTRIES = 400;

const AUDIO_PROMPT = 'Transcribe and extract the expenses.';
const PHOTO_PROMPT = 'This is a receipt. Extract the expense(s).';
const MAX_MESSAGE_LENGTH = 300;
// Server limits (newEntrySchema): anything longer would only fail later, when the person taps Save.
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', fr: 'French' };
const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

/** §7.4 response schema (OpenAPI subset), verbatim. */
export const PARSE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          occurred_at: { type: 'string' },
          note: { type: 'string', nullable: true },
          confidence: { type: 'number' },
        },
        required: ['amount', 'currency', 'description', 'category', 'occurred_at', 'confidence'],
        propertyOrdering: ['amount', 'currency', 'description', 'category', 'occurred_at', 'note', 'confidence'],
      },
    },
    reply: { type: 'string', nullable: true },
  },
  required: ['transcript', 'entries'],
  // Transcript first: with thinking off, writing the words down before extracting helps audio accuracy.
  propertyOrdering: ['transcript', 'entries', 'reply'],
} as const;

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
export type GenerateContentRequest = {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user'; parts: GeminiPart[] }>;
  generationConfig: {
    temperature: number;
    responseMimeType: 'application/json' | 'text/plain';
    responseSchema?: typeof PARSE_RESPONSE_SCHEMA;
    thinkingConfig?: { thinkingBudget: number };
  };
};

const DEFAULT_MESSAGES: Record<GeminiErrorCode, string> = {
  invalid_key: 'Gemini rejected the API key.',
  model_not_found: 'Model not found.',
  quota: 'Gemini is out of requests for now. Try again in a minute.',
  network: 'Could not reach Gemini. Check the connection.',
  bad_response: 'Gemini answered something that could not be read.',
  unknown: 'Gemini request failed.',
  aborted: 'Request cancelled.',
};

type Auth = { key: string; model: string };
type Media = { blob: Blob; mimeType: string };

// ---------------------------------------------------------------- small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cuts at `max` UTF-16 units (what the server counts) without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function emptyToNull(text: string | null): string | null {
  const trimmed = (text ?? '').trim();
  return trimmed ? trimmed : null;
}

/** 'audio/webm;codecs=opus' → 'audio/webm' (Gemini expects a bare media type). */
function bareMime(type: string): string {
  return (type.split(';')[0] ?? '').trim().toLowerCase();
}

function languageName(lang: Lang): string {
  return LANGUAGE_NAMES[lang] ?? LANGUAGE_NAMES.en;
}

/** Settings may hold "models/gemini-2.5-flash" (the API's resource name); the URL wants the bare id. */
function normalizeModel(model: string): string {
  const id = (model ?? '').trim().replace(/^models\//, '');
  return id || DEFAULT_MODEL;
}

function keyOf(cfg: GeminiConfig): string {
  return (cfg.apiKey ?? '').trim();
}

function requireKey(cfg: GeminiConfig): string {
  const key = keyOf(cfg);
  if (!key) throw new GeminiError('invalid_key', 'No Gemini API key on this device.');
  // A header value with spaces or control characters makes fetch throw a TypeError, which would
  // otherwise be reported as "no network".
  if (/[^\x21-\x7e]/.test(key)) throw new GeminiError('invalid_key', 'The API key contains characters a key cannot have.');
  return key;
}

/** Short, single-line message that can never carry the key. */
function redact(message: string, key: string): string {
  let out = message;
  if (key.length >= 8) out = out.split(key).join('[key]');
  out = out.replace(/AIza[0-9A-Za-z_-]{30,}/g, '[key]');
  return clip(oneLine(out), MAX_MESSAGE_LENGTH);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GeminiError('aborted', DEFAULT_MESSAGES.aborted);
}

/** fetch (or a body read) rejected: cancelled by the caller, or no answer from the network. */
function transportError(err: unknown, signal: AbortSignal | undefined): GeminiError {
  if (err instanceof GeminiError) return err;
  if (signal?.aborted || isAbortError(err)) return new GeminiError('aborted', DEFAULT_MESSAGES.aborted);
  return new GeminiError('network', DEFAULT_MESSAGES.network);
}

/** Anything else that escaped (an unreadable blob, a bug) still reaches the UI as a GeminiError. */
function toGeminiError(err: unknown, signal: AbortSignal | undefined, key: string): GeminiError {
  if (err instanceof GeminiError) return err;
  if (signal?.aborted || isAbortError(err)) return new GeminiError('aborted', DEFAULT_MESSAGES.aborted);
  const message = err instanceof Error && err.message ? err.message : DEFAULT_MESSAGES.unknown;
  return new GeminiError('unknown', redact(message, key));
}

// ---------------------------------------------------------------- transport

async function send(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
  try {
    return await fetch(url, signal ? { ...init, signal } : init);
  } catch (err) {
    throw transportError(err, signal);
  }
}

async function readBody(res: Response, signal: AbortSignal | undefined): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const error = transportError(err, signal);
    // For an error status, the status alone still says what went wrong.
    if (error.code === 'aborted' || res.ok) throw error;
    return '';
  }
}

/** `error.message` of a Google API error body ('' when there is none). */
function apiMessageOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const envelope: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    if (isRecord(envelope) && isRecord(envelope.error) && typeof envelope.error.message === 'string') return envelope.error.message;
  } catch {
    // Not JSON (proxy pages, empty bodies): no API message.
  }
  return '';
}

function mentionsKeyProblem(body: string): boolean {
  return /API_KEY_INVALID|API key/i.test(body);
}

/** HTTP status (+ body) → error code (§7.1; for the key check §7.2 maps every 400 to invalid_key). */
function codeForStatus(status: number, body: string, purpose: 'check' | 'generate'): GeminiErrorCode {
  if (status === 400) return purpose === 'check' || mentionsKeyProblem(body) ? 'invalid_key' : 'unknown';
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'quota';
  return 'unknown';
}

function httpError(status: number, body: string, auth: Auth, purpose: 'check' | 'generate'): GeminiError {
  const code = codeForStatus(status, body, purpose);
  const fallback =
    code === 'model_not_found' ? `Model not found: ${auth.model}.` : code === 'unknown' ? `Gemini request failed (HTTP ${status}).` : DEFAULT_MESSAGES[code];
  return new GeminiError(code, redact(apiMessageOf(body) || fallback, auth.key), status);
}

function parseEnvelope(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new GeminiError('bad_response', 'Gemini sent a response that is not JSON.');
  }
}

/** Joined text of the first candidate (thought parts skipped). No candidate or no text → bad_response. */
export function extractResponseText(data: unknown): string {
  const candidates: unknown[] = isRecord(data) && Array.isArray(data.candidates) ? data.candidates : [];
  const first = candidates[0];
  if (!isRecord(first)) {
    const feedback = isRecord(data) && isRecord(data.promptFeedback) ? data.promptFeedback : {};
    const reason = typeof feedback.blockReason === 'string' ? feedback.blockReason : '';
    throw new GeminiError('bad_response', reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned no answer.');
  }
  const parts: unknown[] = isRecord(first.content) && Array.isArray(first.content.parts) ? first.content.parts : [];
  let text = '';
  for (const part of parts) {
    if (isRecord(part) && part.thought !== true && typeof part.text === 'string') text += part.text;
  }
  if (!text.trim()) {
    const finish = typeof first.finishReason === 'string' && first.finishReason !== 'STOP' ? first.finishReason : '';
    throw new GeminiError('bad_response', finish ? `Gemini returned no text (${finish}).` : 'Gemini returned an empty answer.');
  }
  return text;
}

function withoutThinking(request: GenerateContentRequest): GenerateContentRequest {
  const generationConfig = { ...request.generationConfig };
  delete generationConfig.thinkingConfig;
  return { ...request, generationConfig };
}

/** POST :generateContent and return the answer text, retrying once without thinkingConfig when the model refuses it. */
async function generate(auth: Auth, request: GenerateContentRequest, signal: AbortSignal | undefined): Promise<string> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(auth.model)}:generateContent`;
  let body = request;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    const res = await send(
      url,
      { method: 'POST', headers: { 'x-goog-api-key': auth.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      signal,
    );
    const text = await readBody(res, signal);
    if (res.ok) return extractResponseText(parseEnvelope(text));
    const thinkingRefused =
      res.status === 400 && body.generationConfig.thinkingConfig !== undefined && !mentionsKeyProblem(text) && /thinking/i.test(apiMessageOf(text) || text);
    // Models that cannot turn thinking off, or that predate it, reject the field (§7.1).
    if (attempt === 1 && thinkingRefused) {
      body = withoutThinking(body);
      continue;
    }
    throw httpError(res.status, text, auth, 'generate');
  }
}

// ---------------------------------------------------------------- request building

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: spreading megabytes into String.fromCharCode would overflow the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function prepareAudio(blob: Blob): Promise<Media> {
  if (WAV_TYPES.has(bareMime(blob.type))) return { blob, mimeType: 'audio/wav' };
  try {
    return { blob: await blobToWav16k(blob), mimeType: 'audio/wav' };
  } catch {
    // §7.3: when this browser cannot decode the recording, Gemini gets the original container.
    return { blob, mimeType: bareMime(blob.type) || 'audio/webm' };
  }
}

async function prepareImage(blob: Blob): Promise<Media> {
  if (isDownscaledJpeg(blob)) return { blob, mimeType: 'image/jpeg' };
  try {
    return { blob: await downscaleToJpeg(blob, PHOTO_MAX_SIDE, PHOTO_QUALITY), mimeType: 'image/jpeg' };
  } catch {
    // Not decodable here (e.g. HEIC on a browser without a decoder): Gemini reads most formats itself.
    return { blob, mimeType: bareMime(blob.type) || 'image/jpeg' };
  }
}

async function inlinePart(media: Media): Promise<GeminiPart> {
  return { inlineData: { mimeType: media.mimeType, data: await blobToBase64(media.blob) } };
}

async function userParts(input: ParseInput): Promise<GeminiPart[]> {
  switch (input.kind) {
    case 'text':
      return [{ text: input.text }];
    case 'audio':
      return [await inlinePart(await prepareAudio(input.blob)), { text: AUDIO_PROMPT }];
    case 'image':
      return [await inlinePart(await prepareImage(input.blob)), { text: PHOTO_PROMPT }];
  }
}

/** "Monday 2026-10-05 14:30 (Europe/Zurich)": device-local wall clock, like every occurred_at. */
function nowLine(ctx: ParseContext): string {
  const minute = toLocalMinute(ctx.now);
  return `${WEEKDAYS[ctx.now.getDay()] ?? ''} ${minute.slice(0, 10)} ${minute.slice(11)} (${ctx.timeZone})`;
}

/** §7.4 system instruction with now, time zone, currency, language and categories filled in. */
export function buildParseSystemInstruction(ctx: ParseContext): string {
  const categories = ctx.categories.map(oneLine).filter(Boolean).join(', ') || '(none)';
  return [
    'You turn what a person typed, said, or photographed into expense entries.',
    `Now: ${nowLine(ctx)}. Currency: ${ctx.currency}. The person's language: ${languageName(ctx.language)}.`,
    `Categories (use exactly one of these names, or "Other"): ${categories}.`,
    'Rules:',
    '- Return one entry per purchase. "groceries 23.40, coffee 4 and the train 22.80" is three entries.',
    `- amount is the number the person pays, in ${ctx.currency}, as a decimal number. Words like "forty-two" are numbers. If they say an amount was split ("we split it", "half each"), amount is their share and note states the total.`,
    '- If another currency is named, keep that currency code in "currency" and mention it in the note.',
    '- description: short, specific, Title Case for names ("Migros lunch", "TPG ticket", "Dinner, Bains des Pâquis"); no amounts, no dates.',
    '- occurred_at: ISO local "YYYY-MM-DDTHH:MM". Resolve "yesterday", "this morning", "Saturday". Default to now. Receipts: use the printed date/time if legible.',
    '- category: the best match from the list; otherwise "Other".',
    '- note: only useful extras (split, who with, half fare, items on a receipt); else null.',
    '- confidence: 0..1 for the whole entry.',
    '- transcript: the verbatim words for audio; the input text for text; "" for images.',
    "- If nothing is an expense, return entries: [] and a one-sentence reply in the person's language saying what was missing.",
  ].join('\n');
}

/** Full generateContent body for a parse (§7.1/§7.3/§7.4); converts audio/photos as §7.3 describes. */
export async function buildParseRequest(input: ParseInput, ctx: ParseContext): Promise<GenerateContentRequest> {
  return {
    systemInstruction: { parts: [{ text: buildParseSystemInstruction(ctx) }] },
    contents: [{ role: 'user', parts: await userParts(input) }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: PARSE_RESPONSE_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

type AskEntry = AskContext['entries'][number];

function entryLine(entry: AskEntry, other: string): string {
  const fields = [
    entry.occurred_at.replace('T', ' '),
    `${formatAmount(entry.amount_cents)} ${entry.currency}`,
    oneLine(entry.category ?? '') || other,
    oneLine(entry.description),
  ];
  const note = oneLine(entry.note ?? '');
  return fields.join(' · ') + (note ? ` | ${note}` : '');
}

/** §7.5 system instruction: period, total, per-category totals and up to 400 entries, newest first. */
export function buildAskSystemInstruction(ctx: AskContext): string {
  const fr = ctx.language === 'fr';
  const other = fr ? 'Autre' : 'Other';
  const none = fr ? '(aucune)' : '(none)';
  const sorted = [...ctx.entries].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
  const shown = sorted.slice(0, ASK_MAX_ENTRIES);
  const hidden = sorted.length - shown.length;
  const lines = [
    `You answer questions about a person's expenses. Answer in ${languageName(ctx.language)} in one or two short sentences with exact amounts in ${ctx.currency} (format ${formatAmount(128460)}). Only use the data below. If the data cannot answer, say so.`,
    // Not in §7.5's text, but "yesterday" or "this week" cannot be answered without today's date.
    `Now: ${nowLine(ctx)}.`,
    `Period: ${oneLine(ctx.periodLabel)} (${ctx.from}..${ctx.to}). Total: ${formatAmount(ctx.totalCents)} ${ctx.currency}.`,
    'By category:',
    ...(ctx.byCategory.length ? ctx.byCategory.map((c) => `- ${oneLine(c.name) || other} ${formatAmount(c.totalCents)} ${ctx.currency}`) : [none]),
    'Entries (date time amount category description | note):',
    ...(shown.length ? shown.map((entry) => entryLine(entry, other)) : [none]),
  ];
  if (hidden > 0) lines.push(fr ? `…et ${hidden} de plus` : `…and ${hidden} more`);
  return lines.join('\n');
}

/** Full generateContent body for "Ask your data" (§7.5): plain text out, temperature 0.3, thinking off. */
export function buildAskRequest(question: string, ctx: AskContext): GenerateContentRequest {
  return {
    systemInstruction: { parts: [{ text: buildAskSystemInstruction(ctx) }] },
    contents: [{ role: 'user', parts: [{ text: question.trim() }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'text/plain', thinkingConfig: { thinkingBudget: 0 } },
  };
}

// ---------------------------------------------------------------- response parsing

/** The model's JSON, tolerating ```json fences and stray prose around the object. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // Try the next reading.
    }
  }
  throw new GeminiError('bad_response', 'Gemini answered something that is not valid JSON.');
}

function toConfidence(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
}

/**
 * Leniency the shared schema does not express: a confidence outside 0..1 is clamped rather than
 * failing the whole answer, and null for a defaulted string field means "missing".
 */
function relaxModelJson(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const out: Record<string, unknown> = { ...json };
  if (out.transcript === null) delete out.transcript;
  if (Array.isArray(out.entries)) {
    out.entries = out.entries.map((entry: unknown) => {
      if (!isRecord(entry)) return entry;
      const relaxed: Record<string, unknown> = { ...entry };
      for (const field of ['currency', 'description', 'occurred_at']) if (relaxed[field] === null) delete relaxed[field];
      const confidence = toConfidence(relaxed.confidence);
      if (confidence === undefined) delete relaxed.confidence;
      else relaxed.confidence = confidence;
      return relaxed;
    });
  }
  return out;
}

function normalizeCurrency(code: string, fallback: string): string {
  const upper = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : fallback;
}

function fold(text: string): string {
  return text.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The person's own spelling of the category the model named (case-, space- and accent-insensitive); else null ("Other"). */
export function matchCategory(name: string | null, categories: readonly string[]): string | null {
  const wanted = (name ?? '').trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  const exact = categories.find((c) => c.trim().toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const folded = fold(wanted);
  return categories.find((c) => fold(c) === folded) ?? null;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A valid 'YYYY-MM-DDTHH:MM' is kept; seconds are truncated (as is a zone suffix, which the model
 * adds out of habit although it is told to write local time); a bare date keeps the current time
 * of day; anything else becomes now.
 */
export function normalizeOccurredAt(value: string, now: Date): string {
  const nowMinute = toLocalMinute(now);
  const match = DATE_TIME.exec(value.trim());
  const day = match?.[1];
  if (!day) return nowMinute;
  const candidate = `${day}T${match?.[2] ?? nowMinute.slice(11)}`;
  return isValidMinute(candidate) ? candidate : nowMinute;
}

type RawEntry = GeminiParseRaw['entries'][number];

function normalizeEntry(entry: RawEntry, ctx: ParseContext): ParsedEntry {
  return {
    amount_cents: Math.round(entry.amount * 100),
    currency: normalizeCurrency(entry.currency, ctx.currency),
    description: clip(oneLine(entry.description), MAX_DESCRIPTION_LENGTH) || (ctx.language === 'fr' ? 'Dépense' : 'Expense'),
    category: matchCategory(entry.category, ctx.categories),
    occurred_at: normalizeOccurredAt(entry.occurred_at, ctx.now),
    note: emptyToNull(clip(oneLine(entry.note ?? ''), MAX_NOTE_LENGTH)),
    confidence: Number.isFinite(entry.confidence) ? Math.min(1, Math.max(0, entry.confidence)) : 0.5,
  };
}

/** Validated model output → what the UI shows (rules in docs/SPEC.md §7.1/§7.4). */
export function normalizeParsed(raw: GeminiParseRaw, ctx: ParseContext): ParseResult {
  return {
    transcript: raw.transcript.trim(),
    entries: raw.entries.map((entry) => normalizeEntry(entry, ctx)),
    reply: emptyToNull(raw.reply),
  };
}

/** Model text → validated, normalised ParseResult. Unreadable JSON or an unexpected shape → bad_response. */
export function parseResponseText(text: string, ctx: ParseContext): ParseResult {
  const result = geminiParseSchema.safeParse(relaxModelJson(parseModelJson(text)));
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : 'answer';
    throw new GeminiError('bad_response', `Gemini's answer has an unexpected shape (${where}: ${issue?.message ?? 'invalid'}).`);
  }
  return normalizeParsed(result.data, ctx);
}

// ---------------------------------------------------------------- public API (§7.6)

/** §7.2: GET the model with the key. Never throws, except GeminiError('aborted') when the signal fires. */
export async function checkKey(cfg: GeminiConfig, opts: { signal?: AbortSignal } = {}): Promise<KeyCheck> {
  const { signal } = opts;
  const model = normalizeModel(cfg.model);
  try {
    throwIfAborted(signal);
    const auth: Auth = { key: requireKey(cfg), model };
    const res = await send(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}`, { method: 'GET', headers: { 'x-goog-api-key': auth.key } }, signal);
    const body = await readBody(res, signal);
    if (!res.ok) throw httpError(res.status, body, auth, 'check');
    if (!supportsGenerateContent(body)) return { ok: false, code: 'model_not_found', message: `${model} cannot generate content.` };
    return { ok: true, model };
  } catch (err) {
    const error = toGeminiError(err, signal, keyOf(cfg));
    if (error.code === 'aborted') throw error;
    return { ok: false, code: error.code, message: error.message };
  }
}

// An embedding-only model passes the GET but would fail every parse; say so at setup time instead.
function supportsGenerateContent(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && Array.isArray(parsed.supportedGenerationMethods)) return parsed.supportedGenerationMethods.includes('generateContent');
  } catch {
    // Unreadable body: the 200 alone says the key and the model are fine.
  }
  return true;
}

/** Text, voice or receipt → entries (§7.1–§7.4). Throws GeminiError. */
export async function parseExpenses(
  cfg: GeminiConfig,
  input: ParseInput,
  ctx: ParseContext,
  opts: { signal?: AbortSignal } = {},
): Promise<ParseResult> {
  const { signal } = opts;
  try {
    throwIfAborted(signal);
    const auth: Auth = { key: requireKey(cfg), model: normalizeModel(cfg.model) };
    const request = await buildParseRequest(input, ctx);
    return parseResponseText(await generate(auth, request, signal), ctx);
  } catch (err) {
    throw toGeminiError(err, signal, keyOf(cfg));
  }
}

/** "Ask your data" (§7.5): the trimmed plain-text answer. Throws GeminiError. */
export async function askData(cfg: GeminiConfig, question: string, ctx: AskContext, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const { signal } = opts;
  try {
    throwIfAborted(signal);
    const auth: Auth = { key: requireKey(cfg), model: normalizeModel(cfg.model) };
    return (await generate(auth, buildAskRequest(question, ctx), signal)).trim();
  } catch (err) {
    throw toGeminiError(err, signal, keyOf(cfg));
  }
}
