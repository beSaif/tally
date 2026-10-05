/** Picks the default currency for setup from the device locale's region (spec §3.2). */
import { CURRENCIES, DEFAULT_CURRENCY } from '@shared/constants';

const EURO = new Set([
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
  'MC', 'SM', 'VA', 'AD', 'ME', 'XK', 'GF', 'GP', 'MQ', 'RE', 'YT', 'PM', 'BL', 'MF',
]);

const BY_REGION: Record<string, string> = {
  CH: 'CHF', LI: 'CHF', US: 'USD', GB: 'GBP', JP: 'JPY', CA: 'CAD', AU: 'AUD', IN: 'INR', SE: 'SEK', NO: 'NOK',
  DK: 'DKK', PL: 'PLN', CZ: 'CZK', AE: 'AED', SG: 'SGD', BR: 'BRL', MX: 'MXN', ZA: 'ZAR', TR: 'TRY', CN: 'CNY', KR: 'KRW',
};

/** Region subtag of a BCP 47 tag ("fr-CH" → "CH", "zh-Hans-CN" → "CN"), or null. */
export function regionOf(tag: string): string | null {
  for (const part of tag.split(/[-_]/).slice(1)) {
    if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
    if (/^\d{3}$/.test(part)) return null;
  }
  return null;
}

export function defaultCurrency(languages: readonly string[]): string {
  const offered = new Set(CURRENCIES.map((c) => c.code));
  for (const tag of languages) {
    const region = regionOf(tag);
    if (!region) continue;
    const code = EURO.has(region) ? 'EUR' : BY_REGION[region];
    if (code && offered.has(code)) return code;
  }
  return DEFAULT_CURRENCY;
}
