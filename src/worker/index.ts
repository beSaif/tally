import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { handleError } from './lib/http';
import { sameOriginGuard } from './lib/auth';
import { authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { categoriesRoutes } from './routes/categories';
import { entriesRoutes } from './routes/entries';
import { summaryRoutes } from './routes/summary';
import { exportRoutes } from './routes/export';
import { pushRoutes } from './routes/push';
import { runScheduled } from './push/scheduled';

const app = new Hono<AppEnv>();

app.onError(handleError);

app.use('/api/*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
});
app.use('/api/*', sameOriginGuard);

app.get('/api/health', (c) => c.json({ ok: true, name: 'tally' }));
app.route('/api/auth', authRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/entries', entriesRoutes);
app.route('/api/summary', summaryRoutes);
app.route('/api', exportRoutes); // defines GET /export.csv
app.route('/api/push', pushRoutes);

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404);
  }
  // Static assets normally never reach the Worker (run_worker_first is limited to /api/*).
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;

export { app };
