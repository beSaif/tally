import { Hono } from 'hono';
import type { Summary, SummaryCategory } from '@shared/api';
import type { DayRange } from '@shared/dates';
import { summaryQuerySchema } from '@shared/schemas';
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
