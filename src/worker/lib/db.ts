import type { Category, Settings } from '@shared/api';
import type { Env } from '../env';

export const uuid = (): string => crypto.randomUUID();
export const nowMs = (): number => Date.now();

export interface SettingsRow {
  user_id: string;
  currency: string;
  language: 'auto' | 'en' | 'fr';
  budget_cents: number | null;
  model: string;
  setup_complete: number;
  notif_reminder: number;
  notif_reminder_time: string;
  notif_reminder_only_if_empty: number;
  notif_budget: number;
  notif_weekly: number;
  notif_monthly: number;
  created_at: number;
  updated_at: number;
}

export interface CategoryRow {
  id: string;
  user_id: string;
  name: string;
  position: number;
  created_at: number;
  budget_cents: number | null;
  fixed: number;
}

export function settingsFromRow(r: SettingsRow): Settings {
  return {
    currency: r.currency,
    language: r.language,
    budget_cents: r.budget_cents,
    model: r.model,
    setup_complete: r.setup_complete === 1,
    notifications: {
      reminder: r.notif_reminder === 1,
      reminder_time: r.notif_reminder_time,
      reminder_only_if_empty: r.notif_reminder_only_if_empty === 1,
      budget: r.notif_budget === 1,
      weekly: r.notif_weekly === 1,
      monthly: r.notif_monthly === 1,
    },
    updated_at: r.updated_at,
  };
}

export function categoryFromRow(r: CategoryRow): Category {
  return { id: r.id, name: r.name, position: r.position, budget_cents: r.budget_cents, fixed: r.fixed === 1 };
}

export async function loadSettingsRow(env: Env, userId: string): Promise<SettingsRow | null> {
  return env.DB.prepare('SELECT * FROM settings WHERE user_id = ?').bind(userId).first<SettingsRow>();
}

export async function loadSettings(env: Env, userId: string): Promise<Settings | null> {
  const row = await loadSettingsRow(env, userId);
  return row ? settingsFromRow(row) : null;
}

export async function loadCategories(env: Env, userId: string): Promise<Category[]> {
  const { results } = await env.DB.prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY position, created_at')
    .bind(userId)
    .all<CategoryRow>();
  return results.map(categoryFromRow);
}
