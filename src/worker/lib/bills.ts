import type { Bill, BillMode, Cadence, EntrySource } from '@shared/api';
import { isOccurrence, previousBefore } from '@shared/bills';
import type { Env } from '../env';

export interface BillRow {
  id: string;
  amount_cents: number;
  currency: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  cadence: Cadence;
  anchor: string;
  next_due: string;
  mode: BillMode;
  created_at: number;
  updated_at: number;
}

/** The columns of a `Bill`; the join carries the owner, as ENTRY_SELECT does. */
export const BILL_SELECT = `SELECT b.id, b.amount_cents, b.currency, b.description, b.category_id, c.name AS category_name,
       b.cadence, b.anchor, b.next_due, b.mode, b.created_at, b.updated_at
  FROM bills b LEFT JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id`;

export function billFromRow(r: BillRow): Bill {
  return {
    id: r.id,
    amount_cents: r.amount_cents,
    currency: r.currency,
    description: r.description,
    category_id: r.category_id,
    category_name: r.category_name,
    cadence: r.cadence,
    anchor: r.anchor,
    next_due: r.next_due,
    mode: r.mode,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function loadBills(env: Env, userId: string): Promise<Bill[]> {
  const { results } = await env.DB.prepare(`${BILL_SELECT} WHERE b.user_id = ? ORDER BY b.next_due, b.description`).bind(userId).all<BillRow>();
  return results.map(billFromRow);
}

export interface BillEntry {
  entryId: string;
  userId: string;
  billId: string;
  occurredAt: string;
  /** The bill's next_due when the payment was decided: nothing is logged if it moved since. */
  due: string;
  /** The occurrence this payment pays (`due`, or a later one when sync catches up several). */
  paysFor: string;
  source: EntrySource;
  rawInput: string | null;
  now: number;
}

/**
 * Logs one payment of a bill as an entry, with the bill's current amount, wording and category.
 * Inserts nothing when the bill is gone or its next_due is no longer `due` (another device or tap
 * got there first), which is what makes paying and syncing safe to repeat.
 */
export function insertBillEntry(db: D1Database, e: BillEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO entries
         (id, user_id, amount_cents, currency, description, category_id, occurred_at, note, source, raw_input, bill_id, bill_due, created_at, updated_at)
       SELECT ?, b.user_id, b.amount_cents, b.currency, b.description, b.category_id, ?, NULL, ?, ?, b.id, ?, ?, ?
         FROM bills b WHERE b.id = ? AND b.user_id = ? AND b.next_due = ?`,
    )
    .bind(e.entryId, e.occurredAt, e.source, e.rawInput, e.paysFor, e.now, e.now, e.billId, e.userId, e.due);
}

/** Moves a bill from `due` to `next` (on, or back when a payment is deleted); does nothing if it already moved. */
export function advanceBill(db: D1Database, userId: string, billId: string, due: string, next: string, now: number): D1PreparedStatement {
  return db
    .prepare('UPDATE bills SET next_due = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND user_id = ? AND next_due = ?')
    .bind(next, now, billId, userId, due);
}

/** A bill payment about to be deleted. */
export interface PaymentRow {
  id: string;
  bill_id: string;
  bill_due: string | null;
  occurred_at: string;
  created_at: number;
}

/**
 * Where a bill goes back to when `payment` is deleted: the occurrence it paid becomes due again,
 * as long as it was the bill's latest payment (deleting an older one leaves the bill where it is).
 * Payments logged before entries.bill_due existed paid the occurrence just before next_due.
 * Returns the advanceBill arguments that move it back, or null when it stays.
 */
export async function unpayTarget(db: D1Database, userId: string, payment: PaymentRow): Promise<{ from: string; to: string } | null> {
  const bill = await db
    .prepare('SELECT cadence, anchor, next_due FROM bills WHERE id = ? AND user_id = ?')
    .bind(payment.bill_id, userId)
    .first<Pick<BillRow, 'cadence' | 'anchor' | 'next_due'>>();
  if (!bill) return null;
  const later = payment.bill_due
    ? db
        .prepare('SELECT 1 FROM entries WHERE user_id = ? AND bill_id = ? AND id != ? AND bill_due >= ? LIMIT 1')
        .bind(userId, payment.bill_id, payment.id, payment.bill_due)
    : db
        .prepare(
          `SELECT 1 FROM entries WHERE user_id = ? AND bill_id = ? AND id != ?
             AND (bill_due IS NOT NULL OR occurred_at > ? OR (occurred_at = ? AND created_at > ?)) LIMIT 1`,
        )
        .bind(userId, payment.bill_id, payment.id, payment.occurred_at, payment.occurred_at, payment.created_at);
  if (await later.first()) return null;
  const to = payment.bill_due ?? previousBefore(bill.anchor, bill.cadence, bill.next_due);
  // Off the bill's beat (its cadence changed since) or not behind it: nothing to undo.
  if (!to || to >= bill.next_due || !isOccurrence(bill.anchor, bill.cadence, to)) return null;
  return { from: bill.next_due, to };
}
