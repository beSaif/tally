import { Hono } from 'hono';
import type { MonthSummary, MonthsSummary, Summary, SummaryCategory } from '@shared/api';
import { addMonths, monthRange, type DayRange } from '@shared/dates';
import { monthsQuerySchema, summaryQuerySchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { readQuery, validation } from '../lib/http';
import { requireUser } from '../lib/auth';
import { assertRange, occurredBounds } from '../lib/range';

interface CategoryTotalRow {
  category_id: string | null;
  name: string | null;
  total_cents: number;
  count: number;
}

interface DayTotalRow {
  day: string;
  total_cents: number;
  count: number;
}

// Ties are broken by name (uncategorised last) so the order is stable between refreshes.
const BY_CATEGORY = `SELECT e.category_id, c.name, SUM(e.amount_cents) AS total_cents, COUNT(*) AS count
  FROM entries e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
  WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?
  GROUP BY e.category_id
  ORDER BY total_cents DESC, c.name IS NULL, c.name`;

const BY_DAY = `SELECT substr(occurred_at, 1, 10) AS day, SUM(amount_cents) AS total_cents, COUNT(*) AS count
  FROM entries
  WHERE user_id = ? AND occurred_at >= ? AND occurred_at <= ?
  GROUP BY day
  ORDER BY day`;

const BY_MONTH_CATEGORY = `SELECT substr(e.occurred_at, 1, 7) AS month, e.category_id, c.name, SUM(e.amount_cents) AS total_cents, COUNT(*) AS count
  FROM entries e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
  WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?
  GROUP BY month, e.category_id
  ORDER BY month, total_cents DESC, c.name IS NULL, c.name`;

/** Longest month range `GET /summary/months` accepts: two years. */
export const MAX_MONTHS = 24;

const sum = (rows: ReadonlyArray<{ total_cents: number; count: number }>) =>
  rows.reduce((acc, r) => ({ total_cents: acc.total_cents + r.total_cents, count: acc.count + r.count }), { total_cents: 0, count: 0 });

export const summaryRoutes = new Hono<AppEnv>();

summaryRoutes.get('/', requireUser, async (c) => {
  const q = readQuery(c, summaryQuerySchema);
  const range: DayRange = { from: q.from, to: q.to };
  assertRange(range);
  let prev: DayRange | null = null;
  if (q.prev_from !== undefined || q.prev_to !== undefined) {
    if (q.prev_from === undefined || q.prev_to === undefined) throw validation('prev_from: prev_from and prev_to go together');
    prev = { from: q.prev_from, to: q.prev_to };
    assertRange(prev, ['prev_from', 'prev_to']);
  }

  const userId = c.var.user.id;
  const db = c.env.DB;
  const statements = [db.prepare(BY_CATEGORY).bind(userId, ...occurredBounds(range)), db.prepare(BY_DAY).bind(userId, ...occurredBounds(range))];
  if (prev) statements.push(db.prepare(BY_CATEGORY).bind(userId, ...occurredBounds(prev)));
  // One batch is one transaction: the totals, categories and days all describe the same snapshot.
  const results = await db.batch(statements);
  // A batch shares one row type; each statement's shape is fixed by its SQL above.
  const categoryRows = (results[0]?.results ?? []) as CategoryTotalRow[];
  const dayRows = (results[1]?.results ?? []) as DayTotalRow[];
  const prevRows = prev ? ((results[2]?.results ?? []) as CategoryTotalRow[]) : null;

  const prevByCategory = new Map(prevRows?.map((r) => [r.category_id, r.total_cents]));
  const byCategory: SummaryCategory[] = categoryRows.map((r) => ({
    category_id: r.category_id,
    name: r.name,
    total_cents: r.total_cents,
    count: r.count,
    ...(prevRows ? { prev_total_cents: prevByCategory.get(r.category_id) ?? 0 } : {}),
  }));

  const summary: Summary = {
    from: range.from,
    to: range.to,
    ...sum(categoryRows),
    by_category: byCategory,
    by_day: dayRows.map((r) => ({ day: r.day, total_cents: r.total_cents, count: r.count })),
    ...(prevRows ? { previous: sum(prevRows) } : {}),
  };
  return c.json(summary);
});

/** Month-by-month totals per category (category trends, the monthly report's history). */
summaryRoutes.get('/months', requireUser, async (c) => {
  const q = readQuery(c, monthsQuerySchema);
  if (q.from > q.to) throw validation('to: must not be before from');
  const keys: string[] = [];
  for (let day = `${q.from}-01`; day.slice(0, 7) <= q.to; day = addMonths(day, 1)) {
    if (keys.length === MAX_MONTHS) throw validation(`to: a range spans at most ${MAX_MONTHS} months`);
    keys.push(day.slice(0, 7));
  }
  const range: DayRange = { from: `${q.from}-01`, to: monthRange(`${q.to}-01`).to };
  const { results } = await c.env.DB.prepare(BY_MONTH_CATEGORY)
    .bind(c.var.user.id, ...occurredBounds(range))
    .all<CategoryTotalRow & { month: string }>();

  const byMonth = new Map<string, MonthSummary>(keys.map((month) => [month, { month, total_cents: 0, count: 0, by_category: [] }]));
  for (const r of results) {
    const m = byMonth.get(r.month);
    if (!m) continue;
    m.total_cents += r.total_cents;
    m.count += r.count;
    m.by_category.push({ category_id: r.category_id, name: r.name, total_cents: r.total_cents, count: r.count });
  }
  const body: MonthsSummary = { months: [...byMonth.values()] };
  return c.json(body);
});
