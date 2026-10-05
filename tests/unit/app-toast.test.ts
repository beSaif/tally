/** One toast at a time; sticky toasts ("Update ready") wait under newer ones and are never lost. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('@app/lib/toast');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toasts', () => {
  it('replaces a transient toast and hides it after its duration', async () => {
    const { showToast, toast } = await load();
    showToast({ text: 'Saved.' });
    showToast({ text: 'Password changed.', duration: 1000 });
    expect(toast.value?.text).toBe('Password changed.');
    vi.advanceTimersByTime(999);
    expect(toast.value?.text).toBe('Password changed.');
    vi.advanceTimersByTime(1);
    expect(toast.value).toBeNull();
    // The first toast's timer was cleared: nothing comes back or goes away later.
    vi.advanceTimersByTime(10_000);
    expect(toast.value).toBeNull();
  });

  it('brings a sticky toast back after a transient one', async () => {
    const { showToast, toast } = await load();
    showToast({ text: 'Update ready', sticky: true });
    showToast({ text: "You're offline." });
    expect(toast.value?.text).toBe("You're offline.");
    vi.advanceTimersByTime(4500);
    expect(toast.value).toMatchObject({ text: 'Update ready', sticky: true });
    // Sticky: no timer hides it.
    vi.advanceTimersByTime(60_000);
    expect(toast.value?.text).toBe('Update ready');
  });

  it('keeps a sticky toast that another sticky toast covers', async () => {
    const { dismissToast, showToast, toast } = await load();
    const first = showToast({ text: 'Update ready (1)', sticky: true });
    const second = showToast({ text: 'Update ready (2)', sticky: true });
    dismissToast(second);
    expect(toast.value?.id).toBe(first);
    dismissToast(first);
    expect(toast.value).toBeNull();
  });

  it('does not lose a parked sticky toast when another sticky toast arrives over a transient one', async () => {
    const { dismissToast, showToast, toast } = await load();
    const first = showToast({ text: 'Update ready (1)', sticky: true });
    showToast({ text: 'Saved.' });
    const second = showToast({ text: 'Update ready (2)', sticky: true });
    expect(toast.value?.id).toBe(second);
    dismissToast(second);
    expect(toast.value?.id).toBe(first);
  });

  it('brings back each covered sticky toast in turn, most recently covered first', async () => {
    const { dismissToast, showToast, toast } = await load();
    const a = showToast({ text: 'A', sticky: true });
    const b = showToast({ text: 'B', sticky: true });
    const c = showToast({ text: 'C', sticky: true });
    showToast({ text: 'transient' });
    vi.advanceTimersByTime(4500);
    expect(toast.value?.id).toBe(c);
    dismissToast();
    expect(toast.value?.id).toBe(b);
    dismissToast();
    expect(toast.value?.id).toBe(a);
    dismissToast();
    expect(toast.value).toBeNull();
  });

  it('forgets a dismissed sticky toast that was waiting underneath', async () => {
    const { dismissToast, showToast, toast } = await load();
    const sticky = showToast({ text: 'Update ready', sticky: true });
    const transient = showToast({ text: 'Saved.' });
    dismissToast(sticky);
    expect(toast.value?.id).toBe(transient);
    vi.advanceTimersByTime(4500);
    expect(toast.value).toBeNull();
  });

  it('ignores a stale id', async () => {
    const { dismissToast, showToast, toast } = await load();
    const old = showToast({ text: 'Saved.' });
    const current = showToast({ text: 'Entry deleted', actionLabel: 'Undo' });
    dismissToast(old);
    expect(toast.value?.id).toBe(current);
  });
});
