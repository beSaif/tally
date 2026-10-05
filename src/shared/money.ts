/** Narrow no-break space: the thousands separator used throughout the design (1 284.60). */
export const NNBSP = ' ';

/** Integer minor units → "1 284.60" (always two decimals, dot, NNBSP thousands). */
export function formatAmount(cents: number, opts: { decimals?: boolean } = {}): string {
  const showDecimals = opts.decimals ?? true;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const int = Math.floor(abs / 100);
  const frac = abs % 100;
  const intStr = groupThousands(int);
  if (!showDecimals && frac === 0) return `${sign}${intStr}`;
  return `${sign}${intStr}.${String(frac).padStart(2, '0')}`;
}

/** Splits a formatted amount for the hero number: integer part and ".60". */
export function splitAmount(cents: number): { int: string; frac: string } {
  const s = formatAmount(cents);
  const i = s.lastIndexOf('.');
  return { int: s.slice(0, i), frac: s.slice(i) };
}

export function groupThousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const fromEnd = s.length - i;
    out += s[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += NNBSP;
  }
  return (n < 0 ? '-' : '') + out;
}

/**
 * Parses what a person types as an amount: "12", "12.5", "12,50", "1 284.60", "CHF 4.50", "4.50 chf".
 * Returns integer cents or null when there is no number.
 */
export function parseAmount(input: string): number | null {
  let s = input.trim().replace(/[  '\s]/g, '');
  s = s.replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  // If both separators appear, the last one is the decimal separator.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = Math.max(lastDot, lastComma);
    const intPart = s.slice(0, dec).replace(/[.,]/g, '');
    s = `${intPart}.${s.slice(dec + 1)}`;
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Budget line: "64% OF 2 000" style value for the whole budget (no decimals when whole). */
export function formatBudget(cents: number): string {
  return formatAmount(cents, { decimals: false });
}

export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}
