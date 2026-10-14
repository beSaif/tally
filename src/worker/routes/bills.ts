/**
 * Recurring bills (docs/SPEC.md §6.6): create, list, edit, stop; pay or skip the occurrence that
 * is due; log the automatic ones that came due (sync); and habits in past entries that look like
 * bills (suggestions).
 */
import { Hono } from 'hono';
import type { Bill, BillSuggestion, Entry } from '@shared/api';
import { findPatterns, foldDescription, isOccurrence, nextAfter, occurrencesBetween } from '@shared/bills';
import { BILL_TIME, DEFAULT_CURRENCY, MAX_BILLS } from '@shared/constants';
import { addDays } from '@shared/dates';
import { billDueSchema, billPatchSchema, dismissSchema, newBillSchema, todaySchema } from '@shared/schemas';
import type { AppEnv, Env } from '../env';
import { queueAlertsFor } from '../lib/alerts';
import { advanceBill, BILL_SELECT, billFromRow, insertBillEntry, loadBills, type BillRow } from '../lib/bills';
import { loadSettingsRow, nowMs, uuid } from '../lib/db';
import { ENTRY_SELECT, entryFromRow, OWN_CATEGORY_SQL, type EntryRow } from '../lib/entries';
import { ensureRates, foreignDays, settleHomeCents } from '../lib/fx';
import { ApiError, notFound, readJson, readQuery, validation } from '../lib/http';
import { requireUser } from '../lib/auth';

/** Most payments one sync logs per bill: a bill left alone for two years does not flood the ledger. */
const MAX_CATCH_UP = 24;
/** How far back suggestions look: a little over a year, enough for three quarterly payments. */
const SUGGESTION_DAYS = 400;
const MAX_SUGGESTIONS = 5;
/** Payments shown on a bill's page. */
const BILL_HISTORY = 12;

const alreadyMoved = () => new ApiError('validation', 'This bill was already paid or skipped', 409);

export const billsRoutes = new Hono<AppEnv>();

billsRoutes.get('/', requireUser, async (c) => c.json({ bills: await loadBills(c.env, c.var.user.id) }));

/**
 * Logs every automatic bill that came due by `today` (the device's local day), oldest first, and
 * returns all bills. Safe to repeat: each payment is guarded by the next_due it was decided on.
 */
billsRoutes.post('/sync', requireUser, async (c) => {
  const { today } = await readJson(c, todaySchema);
  const userId = c.var.user.id;
  const db = c.env.DB;
  const { results: due } = await db
    .prepare(
      `SELECT b.id, b.currency, b.cadence, b.anchor, b.next_due, s.currency AS home FROM bills b JOIN settings s ON s.user_id = b.user_id
        WHERE b.user_id = ? AND b.mode = 'auto' AND b.next_due <= ?`,
    )
    .bind(userId, today)
    .all<Pick<BillRow, 'id' | 'currency' | 'cadence' | 'anchor' | 'next_due'> & { home: string }>();

  const now = nowMs();
  const ids: string[] = [];
  const writes: D1PreparedStatement[] = [];
  /** Days of payments in another currency than the person's, which need that day's rates. */
  const foreign: string[] = [];
  for (const bill of due) {
    const days = occurrencesBetween(bill.anchor, bill.cadence, bill.next_due, today, MAX_CATCH_UP);
    const last = days[days.length - 1];
    if (!last) continue;
    if (bill.currency !== bill.home) foreign.push(...days);
    for (const day of days) {
      const entryId = uuid();
      ids.push(entryId);
      writes.push(insertBillEntry(db, { entryId, userId, billId: bill.id, occurredAt: `${day}T${BILL_TIME}`, due: bill.next_due, paysFor: day, source: 'manual', rawInput: null, now }));
    }
    writes.push(advanceBill(db, userId, bill.id, bill.next_due, nextAfter(bill.anchor, bill.cadence, last), now));
  }
  if (writes.length === 0) return c.json({ bills: await loadBills(c.env, userId), logged: [] });
  await ensureRates(c.env, foreign);

  const idList = ids.map(() => '?').join(', ');
  const results = await db.batch<BillRow | EntryRow>([
    ...writes,
    settleHomeCents(db, userId, `id IN (${idList})`, ...ids),
    db.prepare(`${BILL_SELECT} WHERE b.user_id = ? ORDER BY b.next_due, b.description`).bind(userId),
    db.prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.id IN (${idList})`).bind(userId, ...ids),
  ]);
  const bills = ((results[results.length - 2]?.results ?? []) as BillRow[]).map(billFromRow);
  const logged = ((results[results.length - 1]?.results ?? []) as EntryRow[]).map(entryFromRow);
  queueAlertsFor(c, logged.map((e) => e.occurred_at));
  return c.json({ bills, logged });
});

/** Habits in the last year of entries that look like bills and are neither bills nor dismissed. */
billsRoutes.get('/suggestions', requireUser, async (c) => {
  const { today } = readQuery(c, todaySchema);
  const userId = c.var.user.id;
  const db = c.env.DB;
  const [entriesRes, billsRes, dismissedRes] = await db.batch([
    db
      .prepare(
        `SELECT description, amount_cents, currency, category_id, occurred_at FROM entries
          WHERE user_id = ? AND bill_id IS NULL AND occurred_at >= ? AND occurred_at <= ?`,
      )
      .bind(userId, addDays(today, -SUGGESTION_DAYS), `${today}T23:59`),
    db.prepare('SELECT description FROM bills WHERE user_id = ?').bind(userId),
    db.prepare('SELECT key FROM bill_dismissals WHERE user_id = ?').bind(userId),
  ]);
  const entries = (entriesRes?.results ?? []) as Array<Pick<Entry, 'description' | 'amount_cents' | 'currency' | 'category_id' | 'occurred_at'>>;
  const known = new Set(((billsRes?.results ?? []) as Array<{ description: string }>).map((b) => foldDescription(b.description)));
  const dismissed = new Set(((dismissedRes?.results ?? []) as Array<{ key: string }>).map((d) => d.key));
  const suggestions: BillSuggestion[] = findPatterns(entries, today, known, dismissed).slice(0, MAX_SUGGESTIONS);
  return c.json({ suggestions });
});

/** "Not a bill": the habit stops being suggested. */
billsRoutes.post('/suggestions/dismiss', requireUser, async (c) => {
  const { key } = await readJson(c, dismissSchema);
  await c.env.DB.prepare('INSERT OR IGNORE INTO bill_dismissals (user_id, key, created_at) VALUES (?, ?, ?)').bind(c.var.user.id, key, nowMs()).run();
  return c.body(null, 204);
});

/**
 * A new bill. With `paid_at`, its first occurrence is already paid: that payment is logged as an
 * entry and the bill starts at the next one.
 */
billsRoutes.post('/', requireUser, async (c) => {
  const input = await readJson(c, newBillSchema);
  const userId = c.var.user.id;
  const db = c.env.DB;
  const [settings, count] = await db.batch([
    db.prepare('SELECT currency FROM settings WHERE user_id = ?').bind(userId),
    db.prepare('SELECT COUNT(*) AS n FROM bills WHERE user_id = ?').bind(userId),
  ]);
  if (((count?.results[0] as { n: number } | undefined)?.n ?? 0) >= MAX_BILLS) throw validation(`At most ${MAX_BILLS} bills`);
  const home = (settings?.results[0] as { currency: string } | undefined)?.currency ?? DEFAULT_CURRENCY;
  const currency = input.currency ?? home;

  const id = uuid();
  const now = nowMs();
  const paid = input.paid_at ? input.paid_at : null;
  const nextDue = paid ? nextAfter(input.first_due, input.cadence, input.first_due) : input.first_due;
  if (paid) await ensureRates(c.env, foreignDays(home, [{ currency, day: paid.slice(0, 10) }]));
  const entryId = uuid();
  const statements = [
    db
      .prepare(
        `INSERT INTO bills (id, user_id, amount_cents, currency, description, category_id, cadence, anchor, next_due, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ${OWN_CATEGORY_SQL}, ?, ?, ?, ?, ?, ?)`,
      )
      // The first payment is logged against first_due before the bill moves on.
      .bind(id, userId, input.amount_cents, currency, input.description, input.category_id ?? null, userId, input.cadence, input.first_due, input.first_due, input.mode, now, now),
    ...(paid
      ? [
          insertBillEntry(db, { entryId, userId, billId: id, occurredAt: paid, due: input.first_due, paysFor: input.first_due, source: input.source ?? 'manual', rawInput: input.raw_input ?? null, now }),
          advanceBill(db, userId, id, input.first_due, nextDue, now),
          settleHomeCents(db, userId, 'id = ?', entryId),
        ]
      : []),
    db.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(id, userId),
    db.prepare(`${ENTRY_SELECT} WHERE e.id = ? AND e.user_id = ?`).bind(entryId, userId),
  ];
  const results = await db.batch<BillRow | EntryRow>(statements);
  const billRow = results[results.length - 2]?.results[0] as BillRow | undefined;
  const entryRow = results[results.length - 1]?.results[0] as EntryRow | undefined;
  if (!billRow) throw new ApiError('internal', 'Bill not saved');
  const entry = entryRow ? entryFromRow(entryRow) : null;
  if (entry) queueAlertsFor(c, [entry.occurred_at]);
  return c.json({ bill: billFromRow(billRow), entry }, 201);
});

async function loadBill(env: Env, userId: string, id: string): Promise<Bill> {
  const row = await env.DB.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(id, userId).first<BillRow>();
  if (!row) throw notFound('Bill not found');
  return billFromRow(row);
}

billsRoutes.get('/:id', requireUser, async (c) => {
  const bill = await loadBill(c.env, c.var.user.id, c.req.param('id'));
  const { results } = await c.env.DB.prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.bill_id = ? ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT ?`)
    .bind(c.var.user.id, bill.id, BILL_HISTORY)
    .all<EntryRow>();
  return c.json({ bill, entries: results.map(entryFromRow) });
});

/**
 * Edits a bill. Its beat stays the same while next_due lands on it (undoing a payment, for one);
 * a new cadence or a day off the beat starts the beat again from next_due.
 */
billsRoutes.patch('/:id', requireUser, async (c) => {
  const patch = await readJson(c, billPatchSchema);
  const userId = c.var.user.id;
  const bill = await loadBill(c.env, c.var.user.id, c.req.param('id'));
  const cadence = patch.cadence ?? bill.cadence;
  const nextDue = patch.next_due ?? bill.next_due;
  const anchor = cadence === bill.cadence && isOccurrence(bill.anchor, cadence, nextDue) ? bill.anchor : nextDue;

  const sets = ['cadence = ?', 'anchor = ?', 'next_due = ?', 'updated_at = MAX(?, updated_at + 1)'];
  const values: Array<string | number | null> = [cadence, anchor, nextDue, nowMs()];
  if (patch.amount_cents !== undefined) {
    sets.push('amount_cents = ?');
    values.push(patch.amount_cents);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    values.push(patch.description);
  }
  if (patch.mode !== undefined) {
    sets.push('mode = ?');
    values.push(patch.mode);
  }
  if (patch.category_id !== undefined) {
    sets.push(`category_id = ${OWN_CATEGORY_SQL}`);
    values.push(patch.category_id, userId);
  }
  const db = c.env.DB;
  const [, read] = await db.batch<BillRow>([
    db.prepare(`UPDATE bills SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, bill.id, userId),
    db.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(bill.id, userId),
  ]);
  const row = read?.results[0];
  if (!row) throw notFound('Bill not found');
  return c.json({ bill: billFromRow(row) });
});

/** Stops a bill. The entries that paid it stay, no longer linked. */
billsRoutes.delete('/:id', requireUser, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM bills WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.var.user.id).run();
  if (res.meta.changes === 0) throw notFound('Bill not found');
  return c.body(null, 204);
});

/** "Paid it": logs the due occurrence as an entry and moves the bill to the next one. */
billsRoutes.post('/:id/pay', requireUser, async (c) => {
  const { due, occurred_at } = await readJson(c, billDueSchema);
  const userId = c.var.user.id;
  const bill = await loadBill(c.env, c.var.user.id, c.req.param('id'));
  if (bill.next_due !== due) throw alreadyMoved();
  const db = c.env.DB;
  const entryId = uuid();
  const now = nowMs();
  const occurredAt = occurred_at ?? `${due}T${BILL_TIME}`;
  const home = (await loadSettingsRow(c.env, userId))?.currency ?? DEFAULT_CURRENCY;
  await ensureRates(c.env, foreignDays(home, [{ currency: bill.currency, day: occurredAt.slice(0, 10) }]));
  const results = await db.batch<BillRow | EntryRow>([
    insertBillEntry(db, { entryId, userId, billId: bill.id, occurredAt, due, paysFor: due, source: 'manual', rawInput: null, now }),
    advanceBill(db, userId, bill.id, due, nextAfter(bill.anchor, bill.cadence, due), now),
    settleHomeCents(db, userId, 'id = ?', entryId),
    db.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(bill.id, userId),
    db.prepare(`${ENTRY_SELECT} WHERE e.id = ? AND e.user_id = ?`).bind(entryId, userId),
  ]);
  const billRow = results[3]?.results[0] as BillRow | undefined;
  const entryRow = results[4]?.results[0] as EntryRow | undefined;
  // Another tap or device paid it between our read and the write.
  if (!billRow || !entryRow) throw alreadyMoved();
  const entry = entryFromRow(entryRow);
  queueAlertsFor(c, [entry.occurred_at]);
  return c.json({ bill: billFromRow(billRow), entry });
});

/** "Skip this one": the due occurrence passes without an entry. */
billsRoutes.post('/:id/skip', requireUser, async (c) => {
  const { due } = await readJson(c, billDueSchema);
  const userId = c.var.user.id;
  const bill = await loadBill(c.env, c.var.user.id, c.req.param('id'));
  if (bill.next_due !== due) throw alreadyMoved();
  const db = c.env.DB;
  const [moved, read] = await db.batch<BillRow>([
    advanceBill(db, userId, bill.id, due, nextAfter(bill.anchor, bill.cadence, due), nowMs()),
    db.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(bill.id, userId),
  ]);
  const row = read?.results[0];
  if (!row || moved?.meta.changes === 0) throw alreadyMoved();
  return c.json({ bill: billFromRow(row) });
});
