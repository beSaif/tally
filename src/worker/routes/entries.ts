import { Hono, type Context } from 'hono';
import type { Entry } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/constants';
import { entriesCreateSchema, entryPatchSchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { notFound, readJson } from '../lib/http';
import { nowMs, uuid } from '../lib/db';
import { requireUser } from '../lib/auth';
import { loadCategoryRefs } from '../lib/categories';
import { ENTRY_SELECT, type EntryRow, entryFromRow, listEntries, needsCategoryNames, OWN_CATEGORY_SQL, resolveCategoryId } from '../lib/entries';
import { readRange } from '../lib/range';
import { maybeSendBudgetAlerts } from '../push/notify';

const INSERT_ENTRY = `INSERT INTO entries
  (id, user_id, amount_cents, currency, description, category_id, occurred_at, note, source, raw_input, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${OWN_CATEGORY_SQL}, ?, ?, ?, ?, ?, ?)`;

/**
 * Budget alerts run after the response. They are best effort: a missing ExecutionContext (e.g.
 * app.request without one) or any failure in the push code must never fail the write itself.
 */
function queueBudgetAlerts(c: Context<AppEnv>, occurredAt: string): void {
  try {
    const ctx = c.executionCtx;
    ctx.waitUntil(maybeSendBudgetAlerts(c.env, c.var.user.id, occurredAt).catch((err: unknown) => console.error('Budget alerts failed', err)));
  } catch (err) {
    console.error('Budget alerts not queued', err);
  }
}

/**
 * The latest occurred_at of each month a batch touches. An alert is about one month's total, so a
 * batch that mixes this month with a future-dated entry must still check this month.
 */
function latestPerMonth(occurredAts: readonly string[]): string[] {
  const byMonth = new Map<string, string>();
  for (const at of occurredAts) {
    const month = at.slice(0, 7);
    const latest = byMonth.get(month);
    if (latest === undefined || at > latest) byMonth.set(month, at);
  }
  return [...byMonth.values()];
}

export const entriesRoutes = new Hono<AppEnv>();

entriesRoutes.get('/', requireUser, async (c) => {
  const range = readRange(c);
  return c.json({ entries: await listEntries(c.env, c.var.user.id, range, 'newest-first') });
});

entriesRoutes.post('/', requireUser, async (c) => {
  const { entries: input } = await readJson(c, entriesCreateSchema);
  const userId = c.var.user.id;
  const db = c.env.DB;
  const [categories, settings] = await Promise.all([
    input.some(needsCategoryNames) ? loadCategoryRefs(c.env, userId) : Promise.resolve([]),
    db.prepare('SELECT currency FROM settings WHERE user_id = ?').bind(userId).first<{ currency: string }>(),
  ]);
  const currency = settings?.currency ?? DEFAULT_CURRENCY;
  const now = nowMs();
  const ids = input.map(() => uuid());
  const inserts = input.map((e, i) =>
    db
      .prepare(INSERT_ENTRY)
      .bind(
        ids[i],
        userId,
        e.amount_cents,
        e.currency ?? currency,
        e.description,
        resolveCategoryId(e, categories) ?? null,
        userId,
        e.occurred_at,
        e.note || null,
        e.source,
        e.raw_input ?? null,
        now,
        now,
      ),
  );
  // Reading back in the same transaction returns exactly what was stored (category names included).
  const readBack = db.prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.id IN (${ids.map(() => '?').join(', ')})`).bind(userId, ...ids);
  const results = await db.batch<EntryRow>([...inserts, readBack]);
  const byId = new Map((results[results.length - 1]?.results ?? []).map((r) => [r.id, r]));
  const entries: Entry[] = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [entryFromRow(row)] : [];
  });

  for (const occurredAt of latestPerMonth(input.map((e) => e.occurred_at))) queueBudgetAlerts(c, occurredAt);
  return c.json({ entries }, 201);
});

entriesRoutes.patch('/:id', requireUser, async (c) => {
  const id = c.req.param('id');
  const patch = await readJson(c, entryPatchSchema);
  const userId = c.var.user.id;
  const db = c.env.DB;

  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const set = (sql: string, ...v: Array<string | number | null>) => {
    sets.push(sql);
    values.push(...v);
  };
  if (patch.amount_cents !== undefined) set('amount_cents = ?', patch.amount_cents);
  if (patch.currency !== undefined) set('currency = ?', patch.currency);
  if (patch.description !== undefined) set('description = ?', patch.description);
  if (patch.occurred_at !== undefined) set('occurred_at = ?', patch.occurred_at);
  if (patch.note !== undefined) set('note = ?', patch.note || null);
  if (patch.source !== undefined) set('source = ?', patch.source);
  if (patch.raw_input !== undefined) set('raw_input = ?', patch.raw_input);
  const categories = needsCategoryNames(patch) ? await loadCategoryRefs(c.env, userId) : [];
  const categoryId = resolveCategoryId(patch, categories);
  if (categoryId !== undefined) set(`category_id = ${OWN_CATEGORY_SQL}`, categoryId, userId);
  // Strictly increasing even within one millisecond, so clients can tell versions apart.
  set('updated_at = MAX(?, updated_at + 1)', nowMs());

  const [, readBack] = await db.batch<EntryRow>([
    db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, id, userId),
    db.prepare(`${ENTRY_SELECT} WHERE e.id = ? AND e.user_id = ?`).bind(id, userId),
  ]);
  const row = readBack?.results[0];
  if (!row) throw notFound('Entry not found');

  queueBudgetAlerts(c, row.occurred_at);
  return c.json({ entry: entryFromRow(row) });
});

entriesRoutes.delete('/:id', requireUser, async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.var.user.id).run();
  if (result.meta.changes === 0) throw notFound('Entry not found');
  return c.body(null, 204);
});
