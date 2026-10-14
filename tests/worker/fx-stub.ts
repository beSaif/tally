/**
 * Stands in for the exchange-rate service (lib/fx.ts) in every worker test: fixed rates for any
 * day, so totals are predictable and no test reaches the network. Installed by setup.ts.
 */
import { FX_URL } from '../../src/worker/lib/fx';

/** Units per euro, whatever the day. */
export const TEST_RATES: Record<string, number> = { CHF: 0.9, USD: 1.2, GBP: 0.8, JPY: 160 };

export const fxStub = {
  /** Days asked for, in order. */
  days: [] as string[],
  /** While true the service answers 503, as when it is down. */
  down: false,
  reset(): void {
    this.days = [];
    this.down = false;
  },
};

const INSTALLED = Symbol.for('tally.fxStub');

export function installFxStub(): void {
  const g = globalThis as typeof globalThis & { [INSTALLED]?: true };
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(FX_URL)) return real(input, init);
    const day = url.searchParams.get('date') ?? '';
    fxStub.days.push(day);
    if (fxStub.down) return new Response('unavailable', { status: 503 });
    return Response.json(Object.entries({ EUR: 1, ...TEST_RATES }).map(([quote, rate]) => ({ date: day, base: 'EUR', quote, rate })));
  };
}
