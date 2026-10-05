import { Hono } from 'hono';
import { categoriesInputSchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { readJson, validation } from '../lib/http';
import { loadCategories, nowMs, uuid } from '../lib/db';
import { requireUser } from '../lib/auth';
import { categoryKey } from '../lib/categories';

// Placeholder names are prefix + uuid (≥ 41 chars), so they can never equal a real name (≤ 40).
const PARKED_PREFIX = '~parked~';

export const categoriesRoutes = new Hono<AppEnv>();

categoriesRoutes.get('/', requireUser, async (c) => {
  return c.json({ categories: await loadCategories(c.env, c.var.user.id) });
});

/**
 * Replaces the list. Ids the user owns are kept (renamed, re-positioned by payload order), the
 * user's other categories are deleted (their entries become uncategorised through the FK), and
 * everything else, including ids that are not the user's, is created with a fresh id.
 */
categoriesRoutes.put('/', requireUser, async (c) => {
  const { categories: wanted } = await readJson(c, categoriesInputSchema);
  const names = new Set<string>();
  const ids = new Set<string>();
  wanted.forEach((w, i) => {
    const key = categoryKey(w.name);
    if (names.has(key)) throw validation(`categories.${i}.name: "${w.name}" is already in the list`);
    names.add(key);
    if (w.id === undefined) return;
    if (ids.has(w.id)) throw validation(`categories.${i}.id: listed twice`);
    ids.add(w.id);
  });

  const userId = c.var.user.id;
  const db = c.env.DB;
  const { results: existing } = await db.prepare('SELECT id FROM categories WHERE user_id = ?').bind(userId).all<{ id: string }>();
  const owned = new Set(existing.map((r) => r.id));
  const kept: Array<{ id: string; name: string; position: number }> = [];
  const created: Array<{ id: string; name: string; position: number }> = [];
  wanted.forEach((w, position) => {
    if (w.id !== undefined && owned.has(w.id)) kept.push({ id: w.id, name: w.name, position });
    else created.push({ id: uuid(), name: w.name, position });
  });

  const keptIds = kept.map((k) => k.id);
  const now = nowMs();
  // One transaction, in this order: UNIQUE(user_id, name NOCASE) is checked row by row, so a swap
  // (A→B, B→A), a rename onto a deleted name, or re-adding a deleted name must not collide midway.
  const statements = [
    // Delete by "not kept" rather than by our snapshot, so the result is exactly the payload even
    // if another device added a category meanwhile.
    keptIds.length > 0
      ? db.prepare(`DELETE FROM categories WHERE user_id = ? AND id NOT IN (${keptIds.map(() => '?').join(', ')})`).bind(userId, ...keptIds)
      : db.prepare('DELETE FROM categories WHERE user_id = ?').bind(userId),
    ...(kept.length > 0 ? [db.prepare('UPDATE categories SET name = ? || id WHERE user_id = ?').bind(PARKED_PREFIX, userId)] : []),
    ...kept.map((k) => db.prepare('UPDATE categories SET name = ?, position = ? WHERE id = ? AND user_id = ?').bind(k.name, k.position, k.id, userId)),
    ...created.map((n) =>
      db.prepare('INSERT INTO categories (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').bind(n.id, userId, n.name, n.position, now),
    ),
  ];
  await db.batch(statements);
  return c.json({ categories: await loadCategories(c.env, userId) });
});
