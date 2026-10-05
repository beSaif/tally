/**
 * A tiny History-API router: the current location as a signal, `navigate`, and an in-app `back`.
 * `history.state.depth` counts in-app pushes so "← Back" never leaves the app.
 */
import { signal } from '@preact/signals';

export interface Route {
  path: string;
  query: URLSearchParams;
}

interface HistoryState {
  depth: number;
}

const read = (): Route => ({ path: location.pathname, query: new URLSearchParams(location.search) });
const depth = (): number => (history.state as HistoryState | null)?.depth ?? 0;

export const route = signal<Route>(read());

window.addEventListener('popstate', () => {
  route.value = read();
});

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const next = url.pathname + url.search + url.hash;
  const current = location.pathname + location.search + location.hash;
  if (opts.replace) {
    history.replaceState({ depth: depth() } satisfies HistoryState, '', next);
  } else if (next !== current) {
    history.pushState({ depth: depth() + 1 } satisfies HistoryState, '', next);
    window.scrollTo(0, 0);
  }
  route.value = read();
}

/** Updates the query string in place (no new history entry). */
export function setQuery(params: Record<string, string | null>): void {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(location.pathname + (s ? `?${s}` : ''), { replace: true });
}

/** Goes back when the previous entry is ours, else to `fallback`. */
export function back(fallback = '/'): void {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** Click handler for same-origin links so they route without a reload. */
export function linkTo(to: string) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
}
