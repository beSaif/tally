/**
 * The "Update ready · RELOAD" flow and notification-click routing of src/app/lib/sw-register.ts,
 * with the browser globals it touches replaced by small fakes (a real update cannot be produced in
 * the e2e run: the worker script is served by the Worker and cannot be swapped mid-test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown) => void;

class FakeTarget {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

class FakeWorker extends FakeTarget {
  state = 'installing';
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

class FakeRegistration extends FakeTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
}

class FakeContainer extends FakeTarget {
  controller: object | null = {};
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
}

let container: FakeContainer;
let doc: FakeTarget & { readyState: string; visibilityState: string };
let reload: ReturnType<typeof vi.fn>;

async function load() {
  vi.resetModules();
  const sw = await import('@app/lib/sw-register');
  const toast = await import('@app/lib/toast');
  const router = await import('@app/router');
  return { ...sw, ...toast, ...router };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  container = new FakeContainer();
  doc = Object.assign(new FakeTarget(), { readyState: 'complete', visibilityState: 'visible' });
  reload = vi.fn();
  const win = Object.assign(new FakeTarget(), { scrollTo: vi.fn() });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { serviceWorker: container, language: 'en-CH', languages: ['en-CH'] });
  vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'https://tally.example', reload });
  vi.stubGlobal('history', { state: null, pushState: vi.fn(), replaceState: vi.fn(), back: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerServiceWorker', () => {
  it('registers /sw.js and offers a waiting update; RELOAD hands over and reloads once', async () => {
    const { registerServiceWorker, toast } = await load();
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    registerServiceWorker();
    await flush();
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(toast.value).toMatchObject({ text: 'Update ready', actionLabel: 'Reload', sticky: true });

    toast.value?.onAction?.();
    expect(waiting.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    container.dispatch('controllerchange');
    container.dispatch('controllerchange');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('announces an update found later, but not the very first install', async () => {
    const { registerServiceWorker, toast } = await load();
    registerServiceWorker();
    await flush();
    expect(toast.value).toBeNull();

    // First install: no controller yet, nothing to announce.
    container.controller = null;
    const first = new FakeWorker();
    container.registration.installing = first;
    container.registration.dispatch('updatefound');
    first.state = 'installed';
    first.dispatch('statechange');
    expect(toast.value).toBeNull();

    container.controller = {};
    const next = new FakeWorker();
    container.registration.installing = next;
    container.registration.dispatch('updatefound');
    next.state = 'installed';
    next.dispatch('statechange');
    expect(toast.value?.text).toBe('Update ready');
  });

  it('checks for updates when the app comes back to the front', async () => {
    const { registerServiceWorker } = await load();
    registerServiceWorker();
    await flush();
    doc.dispatch('visibilitychange');
    expect(container.registration.update).toHaveBeenCalledOnce();
  });

  it('routes notification clicks in-app, same origin only', async () => {
    const { registerServiceWorker } = await load();
    registerServiceWorker();
    await flush();
    container.dispatch('message', { data: { type: 'tally:navigate', url: '/overview?p=week' } });
    expect((history.pushState as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2]).toBe('/overview?p=week');
    container.dispatch('message', { data: { type: 'tally:navigate', url: 'https://evil.example/x' } });
    expect((history.pushState as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
