import { describe, expect, it } from 'vitest';
import { BAR_COUNT, BAR_MAX, BAR_MIN, LevelMeter, barHeight, designWave, frozenWave, loudness, noteWave, resample, voiceprint } from '@app/lib/bars';

describe('waveform helpers (design A.2: 46 bars, 4–30px)', () => {
  it('maps levels to bar heights within bounds', () => {
    expect(barHeight(0)).toBe(BAR_MIN);
    expect(barHeight(1)).toBe(BAR_MAX);
    expect(barHeight(7)).toBe(BAR_MAX);
    expect(barHeight(Number.NaN)).toBe(BAR_MIN);
  });

  it('resamples any length to n bars', () => {
    expect(resample([0, 1], 4)).toEqual([0, 0, 1, 1]);
    expect(resample([0, 0.5, 1, 1], 2)).toEqual([0.25, 1]);
    expect(resample([], 3)).toEqual([0, 0, 0]);
  });

  it('shows a spectrum as is and a loudness stream as a filling history', () => {
    const meter = new LevelMeter(10);
    expect(meter.push(new Float32Array(10).fill(0.5))).toEqual(new Array(10).fill(0.5));
    const first = meter.push([0.8]);
    // With 10 bars, the 8-bar faded tail leaves 2 bars of history; the first sample lands in them.
    expect(first.filter((v) => v > 0)).toEqual([expect.closeTo(0.8, 5)]);
    expect(loudness([0.2, 0.4])).toBeCloseTo(0.3);
  });

  it('turns a recording into a normalised voiceprint', () => {
    expect(voiceprint([])).toBeNull();
    expect(voiceprint(new Array(100).fill(0.001))).toBeNull();
    const shape = voiceprint(Array.from({ length: 200 }, (_, i) => (i % 50) / 100));
    expect(shape).toHaveLength(BAR_COUNT);
    expect(Math.max(...(shape ?? []))).toBe(1);
  });

  it('flattens a frozen wave and calms a finished note', () => {
    expect(Math.max(...frozenWave(null))).toBeLessThanOrEqual(0.24);
    expect(Math.min(...frozenWave([1, 0, 1]))).toBeGreaterThanOrEqual(0.06);
    expect(Math.max(...noteWave(designWave()))).toBeLessThanOrEqual(0.7);
    expect(noteWave(null)).toHaveLength(BAR_COUNT);
  });
});
