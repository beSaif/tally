/**
 * Date helpers over the app's local-time strings: day 'YYYY-MM-DD', minute 'YYYY-MM-DDTHH:MM'.
 * No Date-object timezone math leaks out of here except through `localNow`.
 */

export type PeriodKind = 'week' | 'month' | 'year';
export interface DayRange {
  from: string; // inclusive 'YYYY-MM-DD'
  to: string; // inclusive 'YYYY-MM-DD'
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local wall-clock 'YYYY-MM-DDTHH:MM' for a Date (uses the Date's local zone). */
export function toLocalMinute(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local 'YYYY-MM-DD' for a Date. */
export function toLocalDay(d: Date): string {
  return toLocalMinute(d).slice(0, 10);
}

/** Wall-clock parts of an instant in an IANA time zone (used by the Worker's scheduler). */
export function zonedParts(instant: Date, timeZone: string): { day: string; hhmm: string; weekday: number; year: number; month: number; date: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const date = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[parts.weekday ?? 'Sun'] ?? 0;
  return { day: `${year}-${pad(month)}-${pad(date)}`, hhmm: `${pad(hour)}:${pad(minute)}`, weekday, year, month, date, hour, minute };
}

export function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

/** Days in month (1-12). */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' + n days (UTC arithmetic on the calendar day). */
export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

export function addMonths(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(nd)}`;
}

/** 0 = Sunday … 6 = Saturday, for a calendar day. */
export function weekdayOf(day: string): number {
  const { y, m, d } = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ISO week number and ISO year for a calendar day. */
export function isoWeek(day: string): { year: number; week: number } {
  const { y, m, d } = parseDay(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

export function isoWeekKey(day: string): string {
  const { year, week } = isoWeek(day);
  return `${year}-W${pad(week)}`;
}

/** Monday..Sunday range containing `day`. */
export function weekRange(day: string): DayRange {
  const wd = weekdayOf(day); // 0=Sun
  const offsetToMonday = (wd + 6) % 7;
  const from = addDays(day, -offsetToMonday);
  return { from, to: addDays(from, 6) };
}

export function monthRange(day: string): DayRange {
  const { y, m } = parseDay(day);
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
}

export function yearRange(day: string): DayRange {
  const { y } = parseDay(day);
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

export function periodRange(kind: PeriodKind, day: string): DayRange {
  return kind === 'week' ? weekRange(day) : kind === 'month' ? monthRange(day) : yearRange(day);
}

/** The range immediately before `range` of the same kind. */
export function previousRange(kind: PeriodKind, range: DayRange): DayRange {
  if (kind === 'week') return { from: addDays(range.from, -7), to: addDays(range.to, -7) };
  if (kind === 'month') return monthRange(addMonths(range.from, -1));
  const { y } = parseDay(range.from);
  return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
}

/** Shift an anchor day by one period in either direction. */
export function shiftAnchor(kind: PeriodKind, day: string, n: number): string {
  if (kind === 'week') return addDays(day, 7 * n);
  if (kind === 'month') return addMonths(day, n);
  const { y, m, d } = parseDay(day);
  return `${y + n}-${pad(m)}-${pad(Math.min(d, daysInMonth(y + n, m)))}`;
}

/** Inclusive number of days between two calendar days. */
export function daysBetween(from: string, to: string): number {
  const a = parseDay(from), b = parseDay(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) + 1;
}

/** Days remaining in the month after `day` (design: 5 Oct → "26 days left"). */
export function daysLeftInMonth(day: string): number {
  const { y, m, d } = parseDay(day);
  return daysInMonth(y, m) - d;
}

/** Floors 'HH:MM' to the cron slot ('20:37' → '20:30'). */
export function floorToSlot(hhmm: string, slotMinutes: number): string {
  const [h, mi] = hhmm.split(':').map(Number);
  const m = Math.floor((mi ?? 0) / slotMinutes) * slotMinutes;
  return `${pad(h ?? 0)}:${pad(m)}`;
}

export function isValidDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseDay(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function isValidMinute(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return false;
  if (!isValidDay(s.slice(0, 10))) return false;
  const h = Number(s.slice(11, 13)), mi = Number(s.slice(14, 16));
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}
