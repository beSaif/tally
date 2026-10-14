import { Hono } from 'hono';
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
import { queueAlertsFor, queueBudgetAlerts } from '../lib/alerts';
import { advanceBill, type PaymentRow, unpayTarget } from '../lib/bills';
import { ensureRates, fillHomeCents, foreignDays, settleHomeCents } from '../lib/fx';

const INSERT_ENTRY = `INSERT INTO entries
  (id, user_id, amount_cents, currency, description, category_id, occurred_at, note, source, raw_input, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${OWN_CATEGORY_SQL}, ?, ?, ?, ?, ?, ?)`;

export const entriesRoutes = new Hono<AppEnv>();

entriesRoutes.get('/', requireUser, async (c) => {
  const range = readRange(c);
  await fillHomeCents(c.env, c.var.user.id, range);
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
  await ensureRates(c.env, foreignDays(currency, input.map((e) => ({ currency: e.currency ?? currency, day: e.occurred_at.slice(0, 10) }))));
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
  const idList = ids.map(() => '?').join(', ');
  // Reading back in the same transaction returns exactly what was stored (category names included).
  const readBack = db.prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.id IN (${idList})`).bind(userId, ...ids);
  const results = await db.batch<EntryRow>([...inserts, settleHomeCents(db, userId, `id IN (${idList})`, ...ids), readBack]);
  const byId = new Map((results[results.length - 1]?.results ?? []).map((r) => [r.id, r]));
  const entries: Entry[] = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [entryFromRow(row)] : [];
  });

  queueAlertsFor(c, input.map((e) => e.occurred_at));
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
  if (patch.amount_cents !== undefined || patch.currency !== undefined || patch.occurred_at !== undefined) {
    const before = await db
      .prepare('SELECT e.currency, e.occurred_at, s.currency AS home FROM entries e JOIN settings s ON s.user_id = e.user_id WHERE e.id = ? AND e.user_id = ?')
      .bind(id, userId)
      .first<{ currency: string; occurred_at: string; home: string }>();
    if (!before) throw notFound('Entry not found');
    const after = { currency: patch.currency ?? before.currency, day: (patch.occurred_at ?? before.occurred_at).slice(0, 10) };
    await ensureRates(c.env, foreignDays(before.home, [after]));
  }

  const [, , readBack] = await db.batch<EntryRow>([
    db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, id, userId),
    settleHomeCents(db, userId, 'id = ?', id),
    db.prepare(`${ENTRY_SELECT} WHERE e.id = ? AND e.user_id = ?`).bind(id, userId),
  ]);
  const row = readBack?.results[0];
  if (!row) throw notFound('Entry not found');

  queueBudgetAlerts(c, row.occurred_at);
  return c.json({ entry: entryFromRow(row) });
});

/** Deleting a bill's latest payment makes the occurrence it paid due again. */
entriesRoutes.delete('/:id', requireUser, async (c) => {
  const userId = c.var.user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const payment = await db
    .prepare('SELECT id, bill_id, bill_due, occurred_at, created_at FROM entries WHERE id = ? AND user_id = ? AND bill_id IS NOT NULL')
    .bind(id, userId)
    .first<PaymentRow>();
  const back = payment ? await unpayTarget(db, userId, payment) : null;
  const [result] = await db.batch([
    db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').bind(id, userId),
    ...(payment && back ? [advanceBill(db, userId, payment.bill_id, back.from, back.to, nowMs())] : []),
  ]);
  if (result?.meta.changes === 0) throw notFound('Entry not found');
  return c.body(null, 204);
});
