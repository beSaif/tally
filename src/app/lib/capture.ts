/**
 * Capture flow (spec §3.4–3.5): recording → thinking → result | empty | error → save.
 * Shared by the composer (which starts it) and the capture sheet (which renders it).
 */
import { signal } from '@preact/signals';
import type { EntrySource, NewEntry } from '@shared/api';
import { isValidMinute, toLocalMinute } from '@shared/dates';
import { parseAmount } from '@shared/money';
import { GeminiError, parseExpenses, type GeminiErrorCode, type ParseInput, type ParsedEntry } from './gemini';
import { Recorder, blobToWav16k } from './audio';
import { downscaleToJpeg } from './image';
import { api } from './api';
import { BAR_COUNT, LevelMeter } from './bars';
import { amountInputValue, normalizeMinute } from './format';
import { addEntries } from './ledger';
import { categoryIdFor, categoryNames, currency, geminiKey, model } from './store';
import { lang, type TKey } from '../i18n';

export const MAX_RECORDING_MS = 60_000;
/** Shorter than this is almost always an accidental tap: nothing useful to send. */
const MIN_RECORDING_MS = 500;

export type CaptureMode = 'voice' | 'text' | 'photo';

export type CaptureInput =
  | { mode: 'text'; text: string }
  | { mode: 'voice'; blob: Blob; durationMs: number; wave: number[] }
  | { mode: 'photo'; blob: Blob; thumbUrl: string };

export interface Draft {
  key: string;
  amount: string;
  description: string;
  categoryId: string | null;
  occurredAt: string;
  note: string;
  currency: string;
  checked: boolean;
}

export type Gesture = 'pending' | 'tap' | 'hold';
export type CaptureErrorCode = GeminiErrorCode | 'mic' | 'micDenied' | 'tooShort';

export type CaptureState =
  | { kind: 'idle' }
  | { kind: 'recording'; gesture: Gesture; cancelArmed: boolean; starting: boolean }
  | { kind: 'thinking'; input: CaptureInput }
  | { kind: 'result'; input: CaptureInput; transcript: string; drafts: Draft[]; editing: readonly string[]; saving: boolean; error: TKey | null }
  | { kind: 'empty'; input: CaptureInput; transcript: string; reply: string | null }
  | { kind: 'error'; input: CaptureInput | null; code: CaptureErrorCode };

export const capture = signal<CaptureState>({ kind: 'idle' });
/** Live waveform bars (0..1) and recording time, updated while listening. */
export const levels = signal<number[]>(new Array<number>(BAR_COUNT).fill(0));
export const elapsedMs = signal(0);
/** The composer's text, shared so "Type it" can hand text back. */
export const composerText = signal('');
/** Incremented to ask the composer to focus its input / open the camera. */
export const composerFocusRequest = signal(0);
export const photoPickRequest = signal(0);

let recorder: Recorder | null = null;
let recordStart = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let maxTimer: ReturnType<typeof setTimeout> | undefined;
let lastWave: number[] = [];
let inflight: AbortController | null = null;
/** Text cleared from the composer on a successful parse; given back if the sheet is dismissed unsaved. */
let restoreText: string | null = null;

function stopTimers(): void {
  clearInterval(tickTimer);
  clearTimeout(maxTimer);
}

function releaseInput(input: CaptureInput | null | undefined): void {
  if (input?.mode === 'photo') URL.revokeObjectURL(input.thumbUrl);
}

function inputOf(state: CaptureState): CaptureInput | null {
  return state.kind === 'thinking' || state.kind === 'result' || state.kind === 'empty' || state.kind === 'error' ? state.input : null;
}

// ---------------------------------------------------------------- voice

export async function startRecording(gesture: Gesture = 'pending'): Promise<void> {
  if (capture.value.kind !== 'idle') return;
  const rec = new Recorder();
  const meter = new LevelMeter();
  recorder = rec;
  lastWave = [];
  levels.value = new Array<number>(BAR_COUNT).fill(0);
  elapsedMs.value = 0;
  capture.value = { kind: 'recording', gesture, cancelArmed: false, starting: true };
  try {
    await rec.start((l) => {
      if (recorder !== rec) return;
      const bars = meter.push(l);
      levels.value = bars;
      lastWave = bars;
    });
  } catch (err) {
    if (recorder !== rec) return;
    recorder = null;
    const name = err instanceof Error || err instanceof DOMException ? err.name : '';
    capture.value = { kind: 'error', input: null, code: name === 'NotAllowedError' || name === 'SecurityError' ? 'micDenied' : 'mic' };
    return;
  }
  if (recorder !== rec) {
    rec.cancel(); // cancelled while the permission prompt was up
    return;
  }
  recordStart = performance.now();
  const s = capture.value;
  if (s.kind === 'recording') capture.value = { ...s, starting: false };
  tickTimer = setInterval(() => (elapsedMs.value = performance.now() - recordStart), 200);
  maxTimer = setTimeout(() => void finishRecording(true), MAX_RECORDING_MS);
}

export function setGesture(gesture: Gesture): void {
  const s = capture.value;
  if (s.kind === 'recording' && s.gesture !== gesture) capture.value = { ...s, gesture };
}

export function setCancelArmed(armed: boolean): void {
  const s = capture.value;
  if (s.kind === 'recording' && s.cancelArmed !== armed) capture.value = { ...s, cancelArmed: armed };
}

export function isRecording(): boolean {
  return capture.value.kind === 'recording';
}

export async function finishRecording(send: boolean): Promise<void> {
  const s = capture.value;
  const rec = recorder;
  recorder = null;
  stopTimers();
  if (!rec || s.kind !== 'recording') return;
  if (!send || s.starting) {
    rec.cancel();
    capture.value = { kind: 'idle' };
    return;
  }
  const durationMs = performance.now() - recordStart;
  let blob: Blob;
  try {
    blob = await rec.stop();
  } catch {
    capture.value = { kind: 'error', input: null, code: 'mic' };
    return;
  }
  if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
    capture.value = { kind: 'error', input: null, code: 'tooShort' };
    return;
  }
  await run({ mode: 'voice', blob, durationMs, wave: lastWave });
}

// ---------------------------------------------------------------- text & photo

export function submitText(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || capture.value.kind !== 'idle') return;
  void run({ mode: 'text', text: trimmed });
}

export function submitPhoto(file: Blob): void {
  if (capture.value.kind !== 'idle') return;
  void run({ mode: 'photo', blob: file, thumbUrl: URL.createObjectURL(file) });
}

// ---------------------------------------------------------------- Gemini

async function toParseInput(input: CaptureInput): Promise<ParseInput> {
  if (input.mode === 'text') return { kind: 'text', text: input.text };
  if (input.mode === 'voice') {
    // 16 kHz mono WAV is smaller and always accepted; fall back to the recorded container.
    const wav = await blobToWav16k(input.blob).catch(() => input.blob);
    return { kind: 'audio', blob: wav };
  }
  const jpeg = await downscaleToJpeg(input.blob, 1600, 0.85).catch(() => input.blob);
  return { kind: 'image', blob: jpeg };
}

function toDraft(p: ParsedEntry, i: number, now: string): Draft {
  const code = (p.currency || '').trim().toUpperCase();
  return {
    key: `${Date.now().toString(36)}-${i}`,
    amount: amountInputValue(Math.max(0, Math.round(p.amount_cents))),
    description: p.description.trim(),
    categoryId: categoryIdFor(p.category),
    occurredAt: normalizeMinute(p.occurred_at, now),
    note: p.note?.trim() ?? '',
    currency: /^[A-Z]{3}$/.test(code) ? code : currency.value,
    checked: true,
  };
}

async function run(input: CaptureInput): Promise<void> {
  const apiKey = geminiKey.value;
  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  capture.value = { kind: 'thinking', input };
  if (!apiKey) {
    capture.value = { kind: 'error', input, code: 'invalid_key' };
    return;
  }
  try {
    const parseInput = await toParseInput(input);
    const now = new Date();
    const result = await parseExpenses(
      { apiKey, model: model.value },
      parseInput,
      {
        now,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        currency: currency.value,
        language: lang.value,
        categories: categoryNames.value,
      },
      { signal: ctrl.signal },
    );
    if (inflight !== ctrl) return;
    inflight = null;
    if (result.entries.length === 0) {
      capture.value = { kind: 'empty', input, transcript: result.transcript, reply: result.reply };
      return;
    }
    if (input.mode === 'text') {
      restoreText = input.text;
      composerText.value = '';
    }
    const nowMinute = toLocalMinute(now);
    capture.value = {
      kind: 'result',
      input,
      transcript: result.transcript,
      drafts: result.entries.map((p, i) => toDraft(p, i, nowMinute)),
      editing: [],
      saving: false,
      error: null,
    };
  } catch (err) {
    if (inflight !== ctrl) return;
    inflight = null;
    const code: GeminiErrorCode = err instanceof GeminiError ? err.code : 'unknown';
    if (code === 'aborted') return;
    capture.value = { kind: 'error', input, code };
  }
}

// ---------------------------------------------------------------- result editing

function patchResult(fn: (s: Extract<CaptureState, { kind: 'result' }>) => Extract<CaptureState, { kind: 'result' }>): void {
  const s = capture.value;
  if (s.kind === 'result') capture.value = fn(s);
}

export function updateDraft(key: string, patch: Partial<Omit<Draft, 'key'>>): void {
  patchResult((s) => ({ ...s, error: null, drafts: s.drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)) }));
}

export function toggleDraft(key: string): void {
  patchResult((s) => ({ ...s, drafts: s.drafts.map((d) => (d.key === key ? { ...d, checked: !d.checked } : d)) }));
}

export function editAll(): void {
  patchResult((s) => ({ ...s, editing: s.drafts.map((d) => d.key) }));
}

export function editDraft(key: string): void {
  patchResult((s) => (s.editing.includes(key) ? s : { ...s, editing: [...s.editing, key] }));
}

function draftProblem(d: Draft): TKey | null {
  const cents = parseAmount(d.amount);
  if (cents === null || cents > 1_000_000_000) return 'capture.invalidAmount';
  if (!d.description.trim()) return 'capture.invalidWhat';
  if (!isValidMinute(d.occurredAt)) return 'capture.invalidWhen';
  return null;
}

export async function saveCapture(): Promise<boolean> {
  const s = capture.value;
  if (s.kind !== 'result' || s.saving) return false;
  const chosen = s.drafts.filter((d) => d.checked);
  if (chosen.length === 0) return false;
  for (const d of chosen) {
    const problem = draftProblem(d);
    if (problem) {
      capture.value = { ...s, error: problem, editing: s.editing.includes(d.key) ? s.editing : [...s.editing, d.key] };
      return false;
    }
  }
  capture.value = { ...s, saving: true, error: null };
  const source: EntrySource = s.input.mode;
  const raw = s.input.mode === 'text' ? s.input.text : s.input.mode === 'voice' ? s.transcript : 'photo';
  const entries: NewEntry[] = chosen.map((d) => ({
    amount_cents: parseAmount(d.amount) ?? 0,
    currency: d.currency,
    description: d.description.trim(),
    category_id: d.categoryId,
    occurred_at: d.occurredAt,
    note: d.note.trim() || null,
    source,
    raw_input: raw ? raw.slice(0, 4000) : null,
  }));
  try {
    const res = await api.createEntries(entries);
    addEntries(res.entries, { fresh: true });
    restoreText = null;
    releaseInput(s.input);
    capture.value = { kind: 'idle' };
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    return true;
  } catch {
    const now = capture.value;
    if (now.kind === 'result') capture.value = { ...now, saving: false, error: 'capture.saveFailed' };
    return false;
  }
}

// ---------------------------------------------------------------- closing, retrying

export function closeCapture(): void {
  const s = capture.value;
  if (s.kind === 'idle') return;
  if (s.kind === 'recording') {
    void finishRecording(false);
    return;
  }
  if (s.kind === 'result' && s.saving) return;
  inflight?.abort();
  inflight = null;
  if (restoreText !== null && !composerText.value) composerText.value = restoreText;
  restoreText = null;
  releaseInput(inputOf(s));
  capture.value = { kind: 'idle' };
}

/** "Try again": re-send the same input; for voice/photo with nothing found, capture anew. */
export function retryCapture(): void {
  const s = capture.value;
  if (s.kind !== 'error' && s.kind !== 'empty') return;
  const input = s.input;
  if (!input || (s.kind === 'empty' && input.mode === 'voice')) {
    capture.value = { kind: 'idle' };
    void startRecording('tap');
    return;
  }
  if (s.kind === 'empty' && input.mode === 'photo') {
    releaseInput(input);
    capture.value = { kind: 'idle' };
    photoPickRequest.value++;
    return;
  }
  void run(input);
}

/** "Type it": close and put the text (or the transcript) into the composer. */
export function typeInstead(): void {
  const s = capture.value;
  if (s.kind !== 'empty' && s.kind !== 'error') return;
  const text = s.input?.mode === 'text' ? s.input.text : s.kind === 'empty' ? s.transcript : '';
  restoreText = null;
  releaseInput(s.input);
  capture.value = { kind: 'idle' };
  composerText.value = text;
  composerFocusRequest.value++;
}
