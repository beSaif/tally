import { Hono } from 'hono';
import { DEFAULT_CURRENCY } from '@shared/constants';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { entriesCsv } from '../lib/csv';
import { loadSettingsRow } from '../lib/db';
import { fillHomeCents } from '../lib/fx';
import { listEntries } from '../lib/entries';
import { readRange } from '../lib/range';

// Mounted at /api, so requireUser stays on the route: a use('*') here would gate every /api path.
export const exportRoutes = new Hono<AppEnv>();

exportRoutes.get('/export.csv', requireUser, async (c) => {
  const range = readRange(c);
  const userId = c.var.user.id;
  await fillHomeCents(c.env, userId, range);
  // Oldest first: a spreadsheet reads like a ledger, unlike the app's newest-first list.
  const [entries, settings] = await Promise.all([listEntries(c.env, userId, range, 'oldest-first'), loadSettingsRow(c.env, userId)]);
  return c.body(entriesCsv(entries, settings?.currency ?? DEFAULT_CURRENCY), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="tally-${range.from}_${range.to}.csv"`,
  });
});
