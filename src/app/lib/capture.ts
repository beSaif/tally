/**
 * Capture flow (spec §3.4–3.5): recording → thinking → result | empty | error → save.
 * Shared by the composer (which starts it) and the capture sheet (which renders it).
 */
import { signal } from '@preact/signals';
import type { EntrySource, NewEntry } from '@shared/api';
import { isValidMinute } from '@shared/dates';
import { parseAmount } from '@shared/money';
import { GeminiError, parseExpenses, type GeminiErrorCode, type ParseInput, type ParsedEntry } from './gemini';
import { Recorder } from './audio';
import { micPermission, type MicPermission } from './mic';
import { api } from './api';
import { BAR_COUNT, LevelMeter, loudness, voiceprint } from './bars';
import { amountInputValue } from './format';
import { addEntries } from './ledger';
import { categoryIdFor, categoryNames, currency, geminiKey, model } from './store';
import { lang, type TKey } from '../i18n';

export const MAX_RECORDING_MS = 60_000;
/** Shorter than this is almost always an accidental tap: nothing useful to send. */
const MIN_RECORDING_MS = 500;
/** A press released sooner than this is a tap: keep listening until tapped again. */
const TAP_MS = 300;
/**
 * Without a Permissions API answer, a microphone that takes longer than this to start while the
 * press is still undecided was almost certainly held up by a permission prompt, and the prompt
 * took the press with it: nobody is holding the button any more.
 */
const PROMPT_MS = 1000;
/** Loudness frames kept for the voice-note shape (60 s at 60 fps). */
const MAX_HISTORY = 3600;

export type CaptureMode = 'voice' | 'text' | 'photo';

export type CaptureInput =
  | { mode: 'text'; text: string }
  | { mode: 'voice'; blob: Blob; durationMs: number; wave: number[] | null }
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

export interface ResultState {
  kind: 'result';
  input: CaptureInput;
  transcript: string;
  drafts: Draft[];
  /** Keys of the drafts shown as editable fields. */
  editing: readonly string[];
  /** The drafts as they were before editing began, for "Cancel". */
  before: Draft[] | null;
  saving: boolean;
  error: TKey | null;
}

export type CaptureState =
  | { kind: 'idle' }
  | { kind: 'recording'; gesture: Gesture; cancelArmed: boolean; starting: boolean }
  | { kind: 'thinking'; input: CaptureInput }
  | ResultState
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
let history: number[] = [];
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

/**
 * Starts listening. Call it synchronously from the pointerdown handler: the Recorder creates its
 * AudioContext and asks for the microphone inside that user gesture.
 *
 * A permission prompt takes the press with it (on iPhone no release ever reaches the page), so a
 * press that is going to prompt switches to tap mode at once: the sheet's buttons end it instead.
 */
export async function startRecording(gesture: Gesture = 'pending'): Promise<void> {
  if (capture.value.kind !== 'idle') return;
  const rec = new Recorder();
  const meter = new LevelMeter();
  recorder = rec;
  history = [];
  levels.value = new Array<number>(BAR_COUNT).fill(0);
  elapsedMs.value = 0;
  capture.value = { kind: 'recording', gesture, cancelArmed: false, starting: true };
  const pressedAt = performance.now();
  let permission: MicPermission = 'unknown';
  if (gesture === 'pending') {
    void micPermission().then((state) => {
      permission = state;
      if (recorder === rec && (state === 'prompt' || state === 'denied')) keepListening();
    });
  }
  try {
    await rec.start((l) => {
      if (recorder !== rec) return;
      levels.value = meter.push(l);
      if (history.length < MAX_HISTORY) history.push(loudness(l));
    });
  } catch (err) {
    // Cancelled while the permission prompt was up: finishRecording already let go of `rec`.
    if (recorder !== rec) return;
    recorder = null;
    const name = err instanceof Error || err instanceof DOMException ? err.name : '';
    // Anything else is a real failure, AbortError included (the device could not be opened). The
    // sheet must leave "recording": with no recorder left, nothing else could close it.
    capture.value = { kind: 'error', input: null, code: name === 'NotAllowedError' || name === 'SecurityError' ? 'micDenied' : 'mic' };
    return;
  }
  if (recorder !== rec) {
    rec.cancel(); // cancelled while the permission prompt was up
    return;
  }
  recordStart = performance.now();
  const s = capture.value;
  if (s.kind === 'recording') {
    // No answer from the Permissions API: a slow start is the next best sign that a prompt took the press.
    const taken = s.gesture === 'pending' && permission === 'unknown' && recordStart - pressedAt > PROMPT_MS;
    capture.value = { ...s, starting: false, gesture: taken ? 'tap' : s.gesture };
  }
  tickTimer = setInterval(() => (elapsedMs.value = performance.now() - recordStart), 200);
  maxTimer = setTimeout(() => void finishRecording(true), MAX_RECORDING_MS);
}

/**
 * The press that started the recording ended after `heldMs` (pointerup). A quick press, a release
 * while the microphone was still starting (a permission prompt was up), or tap mode already: keep
 * listening until tapped again. A hold sends, or cancels when the finger had slid up.
 */
export function releaseRecording(heldMs: number): void {
  const s = capture.value;
  if (s.kind !== 'recording') return;
  if (s.gesture === 'tap' || s.starting || heldMs < TAP_MS) {
    keepListening();
    return;
  }
  capture.value = { ...s, gesture: 'hold' };
  void finishRecording(!s.cancelArmed);
}

/**
 * The press can no longer end the recording: the system took it (pointercancel: a permission
 * prompt, a call, …) or is about to. Keep listening until tapped, with the sheet's buttons.
 */
export function keepListening(): void {
  const s = capture.value;
  if (s.kind !== 'recording' || s.gesture === 'tap') return;
  capture.value = { ...s, gesture: 'tap', cancelArmed: false };
}

/** Sliding up arms "release to cancel"; meaningless in tap mode, where nothing is held. */
export function setCancelArmed(armed: boolean): void {
  const s = capture.value;
  if (s.kind === 'recording' && s.gesture !== 'tap' && s.cancelArmed !== armed) capture.value = { ...s, cancelArmed: armed };
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
  await run({ mode: 'voice', blob, durationMs, wave: voiceprint(history) });
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

/** The raw recording or picked file: parseExpenses converts it (16 kHz WAV, downscaled JPEG) itself. */
function toParseInput(input: CaptureInput): ParseInput {
  if (input.mode === 'text') return { kind: 'text', text: input.text };
  if (input.mode === 'voice') return { kind: 'audio', blob: input.blob };
  return { kind: 'image', blob: input.blob };
}

let draftSeq = 0;

/** parseExpenses already normalised the entry (whole cents ≥ 0, a valid minute, a 3-letter currency). */
function toDraft(p: ParsedEntry): Draft {
  return {
    key: `d${++draftSeq}`,
    amount: amountInputValue(p.amount_cents),
    description: p.description,
    categoryId: categoryIdFor(p.category),
    occurredAt: p.occurred_at,
    note: p.note ?? '',
    currency: p.currency,
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
    inflight = null;
    capture.value = { kind: 'error', input, code: 'invalid_key' };
    return;
  }
  try {
    const result = await parseExpenses(
      { apiKey, model: model.value },
      toParseInput(input),
      {
        now: new Date(),
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
    capture.value = {
      kind: 'result',
      input,
      transcript: result.transcript,
      drafts: result.entries.map(toDraft),
      editing: [],
      before: null,
      saving: false,
      error: null,
    };
  } catch (err) {
    if (inflight !== ctrl) return;
    inflight = null;
    const code: GeminiErrorCode = err instanceof GeminiError ? err.code : 'unknown';
    // "aborted" is a cancel the person asked for: the sheet is already closed.
    if (code === 'aborted') return;
    capture.value = { kind: 'error', input, code };
  }
}

// ---------------------------------------------------------------- result editing

function patchResult(fn: (s: ResultState) => ResultState): void {
  const s = capture.value;
  if (s.kind === 'result') capture.value = fn(s);
}

export function updateDraft(key: string, patch: Partial<Omit<Draft, 'key'>>): void {
  patchResult((s) => ({ ...s, error: null, drafts: s.drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)) }));
}

export function toggleDraft(key: string): void {
  patchResult((s) => ({ ...s, drafts: s.drafts.map((d) => (d.key === key ? { ...d, checked: !d.checked } : d)) }));
}

/** Edit mode for these drafts; the first edit remembers the values to go back to. */
function startEditing(s: ResultState, keys: readonly string[]): ResultState {
  const editing = [...new Set([...s.editing, ...keys])];
  return { ...s, editing, before: s.before ?? s.drafts.map((d) => ({ ...d })) };
}

export function editAll(): void {
  patchResult((s) => startEditing(s, s.drafts.map((d) => d.key)));
}

export function editDraft(key: string): void {
  patchResult((s) => (s.editing.includes(key) ? s : startEditing(s, [key])));
}

/** "Cancel" in edit mode: the parsed values come back (ticks stay as they are now). */
export function cancelEditing(): void {
  patchResult((s) => {
    const before = new Map((s.before ?? []).map((d) => [d.key, d]));
    const drafts = s.drafts.map((d) => {
      const old = before.get(d.key);
      return old ? { ...old, checked: d.checked } : d;
    });
    return { ...s, drafts, editing: [], before: null, error: null };
  });
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
      capture.value = { ...startEditing(s, [d.key]), error: problem };
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
    // An explicit id (null = Other) and never a name as well: the API lets the id win anyway.
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
