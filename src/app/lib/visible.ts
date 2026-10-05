/**
 * "The app came back to the front" (spec §3.3, §3.9): the tab became visible again or the window
 * got focus. Showing a tab fires both, and a quick back-and-forth needs no new round trip, so each
 * subscriber runs at most once per gap, counted from when it subscribed (right after its own load).
 */
export const APP_VISIBLE_GAP_MS = 2000;

/** Calls `fn` each time the app comes back to the front, at most once per `gapMs`; returns the unsubscribe. */
export function onAppVisible(fn: () => void, gapMs: number = APP_VISIBLE_GAP_MS): () => void {
  // performance.now(): a monotonic clock, unaffected by the device changing its time.
  let last = performance.now();
  const shown = () => {
    if (document.visibilityState !== 'visible' || performance.now() - last < gapMs) return;
    last = performance.now();
    fn();
  };
  document.addEventListener('visibilitychange', shown);
  window.addEventListener('focus', shown);
  return () => {
    document.removeEventListener('visibilitychange', shown);
    window.removeEventListener('focus', shown);
  };
}
