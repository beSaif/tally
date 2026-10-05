import type { Entry } from '@shared/api';

// Excel only reads a CSV as UTF-8 (accents in descriptions, "Santé") when it starts with a BOM.
const BOM = '﻿';
const EOL = '\r\n'; // RFC 4180 record separator

export const ENTRY_CSV_HEADER = ['date', 'time', 'amount', 'currency', 'description', 'category', 'note', 'source', 'id'] as const;

/** RFC 4180: quote only fields holding a quote, comma or line break, doubling inner quotes. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * User-written text may start with a character spreadsheets treat as a formula (=, +, -, @, tab,
 * CR). A leading apostrophe makes Excel, Numbers and Sheets show it as text instead of running it.
 */
export function csvText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

/**
 * Minor units → "1234.50". Unlike the UI's formatAmount there is no thousands separator, so
 * spreadsheets read the column as numbers. Integer maths avoids float artefacts.
 */
export function plainAmount(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function entriesCsv(entries: readonly Entry[]): string {
  const rows = entries.map((e) =>
    csvLine([
      e.occurred_at.slice(0, 10),
      e.occurred_at.slice(11, 16),
      plainAmount(e.amount_cents),
      e.currency,
      csvText(e.description),
      csvText(e.category_name ?? ''),
      csvText(e.note ?? ''),
      e.source,
      e.id,
    ]),
  );
  return BOM + [csvLine(ENTRY_CSV_HEADER), ...rows].join(EOL) + EOL;
}
