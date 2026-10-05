import { Hono } from 'hono';
import type { NotificationPrefs, Settings } from '@shared/api';
import { settingsInputSchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { ApiError, readJson } from '../lib/http';
import { loadSettings, nowMs, settingsFromRow, type SettingsRow } from '../lib/db';
import { requireUser } from '../lib/auth';

const NOTIFICATION_COLUMNS = {
  reminder: 'notif_reminder',
  reminder_time: 'notif_reminder_time',
  reminder_only_if_empty: 'notif_reminder_only_if_empty',
  budget: 'notif_budget',
  weekly: 'notif_weekly',
  monthly: 'notif_monthly',
} as const satisfies Record<keyof NotificationPrefs, string>;

const missingSettings = () => new ApiError('internal', 'Settings missing for user');

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get('/', requireUser, async (c) => {
  const settings = await loadSettings(c.env, c.var.user.id);
  if (!settings) throw missingSettings();
  return c.json({ settings });
});

settingsRoutes.put('/', requireUser, async (c) => {
  const input = await readJson(c, settingsInputSchema);
  // Only the columns that were sent are written, so two devices changing different settings at
  // the same time cannot undo each other. Column names come from this file, never from input.
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const set = (column: string, value: string | number | boolean | null) => {
    sets.push(`${column} = ?`);
    values.push(typeof value === 'boolean' ? Number(value) : value);
  };
  if (input.currency !== undefined) set('currency', input.currency);
  if (input.language !== undefined) set('language', input.language);
  if (input.budget_cents !== undefined) set('budget_cents', input.budget_cents); // null clears the budget
  if (input.model !== undefined) set('model', input.model);
  if (input.setup_complete !== undefined) set('setup_complete', input.setup_complete);
  for (const key of Object.keys(NOTIFICATION_COLUMNS) as Array<keyof NotificationPrefs>) {
    const value = input.notifications?.[key];
    if (value !== undefined) set(NOTIFICATION_COLUMNS[key], value);
  }
  // Strictly increasing even when two writes land in the same millisecond: clients compare it.
  sets.push('updated_at = MAX(?, updated_at + 1)');
  values.push(nowMs());

  const row = await c.env.DB.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE user_id = ? RETURNING *`)
    .bind(...values, c.var.user.id)
    .first<SettingsRow>();
  if (!row) throw missingSettings();
  const settings: Settings = settingsFromRow(row);
  return c.json({ settings });
});
