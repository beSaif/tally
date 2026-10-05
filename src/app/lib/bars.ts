/**
 * Waveform helpers for the capture sheet: 46 bars, 4–30px tall (design A.2).
 * The Recorder reports "levels (0..1 per bar)"; this module adapts whatever length it sends.
 */
export const BAR_COUNT = 46;
export const BAR_MIN = 4;
export const BAR_MAX = 30;
/** The last bars are drawn faded while listening, as in the design (where the next sound will land). */
export const BAR_TAIL = 8;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function barHeight(level: number): number {
  return Math.round(BAR_MIN + clamp01(level) * (BAR_MAX - BAR_MIN));
}

/** Resamples any number of levels to `n` bars (bucket average when shrinking, nearest when stretching). */
export function resample(levels: ArrayLike<number>, n = BAR_COUNT): number[] {
  const len = levels.length;
  const out = new Array<number>(n).fill(0);
  if (len === 0) return out;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * len) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
    let sum = 0;
    for (let j = a; j < b && j < len; j++) sum += clamp01(levels[j] ?? 0);
    out[i] = sum / Math.max(1, Math.min(b, len) - a);
  }
  return out;
}

/**
 * Turns successive level reports into bar values. A report of many values is taken as a spectrum
 * (one value per bar); a report of one or a few values is a loudness sample, kept as a scrolling
 * history that fills the bars left to right, leaving the faded tail for what comes next.
 */
export class LevelMeter {
  private history: number[] = [];
  constructor(private readonly n = BAR_COUNT) {}

  push(levels: ArrayLike<number>): number[] {
    if (levels.length >= 8) return resample(levels, this.n);
    const level = loudness(levels);
    const visible = this.n - BAR_TAIL;
    this.history.push(level);
    if (this.history.length > visible) this.history.splice(0, this.history.length - visible);
    const out = new Array<number>(this.n).fill(0);
    const offset = visible - this.history.length;
    this.history.forEach((v, i) => (out[offset + i] = v));
    return out;
  }
}

/** Mean level of one report (0..1): the loudness of that frame. */
export function loudness(levels: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < levels.length; i++) sum += clamp01(levels[i] ?? 0);
  return levels.length ? sum / levels.length : 0;
}

/**
 * The shape of a whole recording from its per-frame loudness: `n` bars, scaled so the loudest is
 * full height (a quiet room still reads as speech). Empty or silent recordings give null.
 */
export function voiceprint(history: readonly number[], n = BAR_COUNT): number[] | null {
  if (history.length === 0) return null;
  const bars = resample(history, n);
  const peak = Math.max(...bars);
  if (!(peak > 0.02)) return null;
  return bars.map((v) => v / peak);
}

/** The design's illustrative wave: |sin(i·.55)·cos(i·.23)|. */
export function designWave(n = BAR_COUNT): number[] {
  return Array.from({ length: n }, (_, i) => Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.23)));
}

/** Frozen wave while Gemini works: the recording's shape, flattened to a low amplitude. */
export function frozenWave(shape: readonly number[] | null, n = BAR_COUNT): number[] {
  const base = shape && shape.some((v) => v > 0.02) ? resample(shape, n) : designWave(n);
  return base.map((v) => 0.06 + v * 0.18);
}

/** The finished voice note: its shape at a calm amplitude, so it reads as a recording, not a live meter. */
export function noteWave(shape: readonly number[] | null, n = BAR_COUNT): number[] {
  const base = shape && shape.some((v) => v > 0.02) ? resample(shape, n) : designWave(n);
  return base.map((v) => 0.08 + v * 0.62);
}
