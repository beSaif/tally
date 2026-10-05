import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { entriesCsv } from '../lib/csv';
import { listEntries } from '../lib/entries';
import { readRange } from '../lib/range';

// Mounted at /api, so requireUser stays on the route: a use('*') here would gate every /api path.
export const exportRoutes = new Hono<AppEnv>();

exportRoutes.get('/export.csv', requireUser, async (c) => {
  const range = readRange(c);
  // Oldest first: a spreadsheet reads like a ledger, unlike the app's newest-first list.
  const entries = await listEntries(c.env, c.var.user.id, range, 'oldest-first');
  return c.body(entriesCsv(entries), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="tally-${range.from}_${range.to}.csv"`,
  });
});
