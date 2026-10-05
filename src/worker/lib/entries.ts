import type { Entry, EntrySource } from '@shared/api';
import type { DayRange } from '@shared/dates';
import type { Env } from '../env';
import { type CategoryRef, findCategoryByName } from './categories';
import { occurredBounds } from './range';

export interface EntryRow {
  id: string;
  amount_cents: number;
  currency: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  occurred_at: string;
  note: string | null;
  source: EntrySource;
  created_at: number;
  updated_at: number;
}

/**
 * The columns of an `Entry` (raw_input stays server-side). LEFT JOIN so uncategorised entries
 * survive; the user_id condition means a category name can only ever come from the owner's list.
 */
export const ENTRY_SELECT = `SELECT e.id, e.amount_cents, e.currency, e.description, e.category_id, c.name AS category_name,
       e.occurred_at, e.note, e.source, e.created_at, e.updated_at
  FROM entries e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id`;

/**
 * SQL value for entries.category_id, bound as (candidate id, user id). It yields NULL for another
 * user's id, and for a category deleted since we resolved the name, instead of an FK failure.
 */
export const OWN_CATEGORY_SQL = '(SELECT id FROM categories WHERE id = ? AND user_id = ?)';

export function entryFromRow(r: EntryRow): Entry {
  return {
    id: r.id,
    amount_cents: r.amount_cents,
    currency: r.currency,
    description: r.description,
    category_id: r.category_id,
    category_name: r.category_name,
    occurred_at: r.occurred_at,
    note: r.note,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listEntries(env: Env, userId: string, range: DayRange, order: 'newest-first' | 'oldest-first'): Promise<Entry[]> {
  const dir = order === 'newest-first' ? 'DESC' : 'ASC';
  const [start, end] = occurredBounds(range);
  const { results } = await env.DB.prepare(
    `${ENTRY_SELECT}
      WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at <= ?
      ORDER BY e.occurred_at ${dir}, e.created_at ${dir}`,
  )
    .bind(userId, start, end)
    .all<EntryRow>();
  return results.map(entryFromRow);
}

interface CategoryChoice {
  category_id?: string | null;
  category?: string | null;
}

/** True when resolving this input needs the user's category names. */
export const needsCategoryNames = (input: CategoryChoice): boolean => input.category_id === undefined && !!input.category;

/**
 * Which category an entry write asks for. An explicit `category_id` key (even null) wins over the
 * `category` name; names match case-insensitively, unknown names give null. `undefined` means the
 * input says nothing about the category (create: none; patch: keep). The id still goes through
 * OWN_CATEGORY_SQL, which is what enforces ownership.
 */
export function resolveCategoryId(input: CategoryChoice, categories: readonly CategoryRef[]): string | null | undefined {
  if (input.category_id !== undefined) return input.category_id;
  if (input.category === undefined) return undefined;
  if (!input.category) return null;
  return findCategoryByName(categories, input.category)?.id ?? null;
}
