/**
 * onAppVisible (src/app/lib/visible.ts): what refreshes the month, the settings and the service
 * worker when the app comes back to the front, with document and window replaced by small fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VISIBLE_GAP_MS, onAppVisible } from '@app/lib/visible';

type Listener = () => void;

class FakeTarget {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

let doc: FakeTarget & { visibilityState: string };
let win: FakeTarget;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance'] });
  doc = Object.assign(new FakeTarget(), { visibilityState: 'visible' });
  win = new FakeTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('onAppVisible', () => {
  it('waits a gap after subscribing, since the subscriber has just loaded', () => {
    const fn = vi.fn();
    onAppVisible(fn);
    doc.dispatch('visibilitychange');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(APP_VISIBLE_GAP_MS);
    doc.dispatch('visibilitychange');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('runs once when a shown tab fires both visibilitychange and focus, and again after the gap', () => {
    const fn = vi.fn();
    onAppVisible(fn);
    vi.advanceTimersByTime(APP_VISIBLE_GAP_MS);
    doc.dispatch('visibilitychange');
    win.dispatch('focus');
    expect(fn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(APP_VISIBLE_GAP_MS - 1);
    win.dispatch('focus');
    expect(fn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    win.dispatch('focus');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ignores the tab being hidden', () => {
    const fn = vi.fn();
    onAppVisible(fn, 0);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops listening once unsubscribed', () => {
    const fn = vi.fn();
    const stop = onAppVisible(fn, 0);
    stop();
    doc.dispatch('visibilitychange');
    win.dispatch('focus');
    expect(fn).not.toHaveBeenCalled();
    expect(doc.count('visibilitychange') + win.count('focus')).toBe(0);
  });
});
