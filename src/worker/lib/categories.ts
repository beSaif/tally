import type { Env } from '../env';

export interface CategoryRef {
  id: string;
  name: string;
}

/**
 * Comparison key for category names. The table's UNIQUE(name COLLATE NOCASE) only folds ASCII, so
 * "SANTÉ" and "Santé" would be distinct there; people (and Gemini) mean the same category.
 */
export const categoryKey = (name: string): string => name.normalize('NFC').toLowerCase();

export async function loadCategoryRefs(env: Env, userId: string): Promise<CategoryRef[]> {
  const { results } = await env.DB.prepare('SELECT id, name FROM categories WHERE user_id = ?').bind(userId).all<CategoryRef>();
  return results;
}

export function findCategoryByName(categories: readonly CategoryRef[], name: string): CategoryRef | undefined {
  const key = categoryKey(name);
  return categories.find((c) => categoryKey(c.name) === key);
}
