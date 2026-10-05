import { Hono } from 'hono';
import type { PushSubscriptionRow } from '@shared/api';
import { pushPatchSchema, pushSkipSchema, pushSubscribeSchema, pushTestSchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { ApiError, notFound, readJson } from '../lib/http';
import { nowMs, uuid } from '../lib/db';
import { loadSubscriptions, sendToSubscriptions } from '../push/notify';
import { testText } from '../push/strings';
import { vapidFromEnv, type Vapid } from '../push/webpush';

/** Per-device push subscriptions and the test / skip actions (docs/SPEC.md §6, §8). */
export const pushRoutes = new Hono<AppEnv>();

pushRoutes.use('*', requireUser);

const notConfigured = () => new ApiError('internal', 'Push notifications are not configured on this server');

pushRoutes.get('/vapid-public-key', (c) => {
  const key = c.env.VAPID_PUBLIC_KEY?.trim();
  if (!key) throw notConfigured();
  return c.json({ key });
});

pushRoutes.get('/subscriptions', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, endpoint, user_agent, lang, tz, created_at, last_seen_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, id',
  )
    .bind(c.var.user.id)
    .all<PushSubscriptionRow>();
  return c.json({ subscriptions: results });
});

pushRoutes.post('/subscribe', async (c) => {
  const body = await readJson(c, pushSubscribeSchema);
  const now = nowMs();
  // Upsert on the endpoint: re-subscribing refreshes keys, language and zone. An endpoint belongs
  // to one browser profile, so when another account signs in there it takes the device over.
  const row = await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, lang, tz, created_at, last_seen_at, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (endpoint) DO UPDATE SET
       created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END,
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = COALESCE(excluded.user_agent, push_subscriptions.user_agent),
       lang = excluded.lang,
       tz = excluded.tz,
       last_seen_at = excluded.last_seen_at,
       failures = 0
     RETURNING id`,
  )
    .bind(
      uuid(),
      c.var.user.id,
      body.subscription.endpoint,
      body.subscription.keys.p256dh,
      body.subscription.keys.auth,
      body.user_agent ?? null,
      body.lang,
      body.tz,
      now,
      now,
    )
    .first<{ id: string }>();
  if (!row) throw new ApiError('internal', 'Subscription was not stored');
  return c.json({ id: row.id });
});

pushRoutes.patch('/subscriptions/:id', async (c) => {
  const body = await readJson(c, pushPatchSchema);
  // last_seen_at stays: any of the user's sessions may patch a device, so this is no sign of life.
  const res = await c.env.DB.prepare('UPDATE push_subscriptions SET lang = COALESCE(?, lang), tz = COALESCE(?, tz) WHERE id = ? AND user_id = ?')
    .bind(body.lang ?? null, body.tz ?? null, c.req.param('id'), c.var.user.id)
    .run();
  if (res.meta.changes === 0) throw notFound('No such subscription');
  return c.body(null, 204);
});

pushRoutes.delete('/subscriptions/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.var.user.id).run();
  if (res.meta.changes === 0) throw notFound('No such subscription');
  return c.body(null, 204);
});

pushRoutes.post('/test', async (c) => {
  const body = await readJson(c, pushTestSchema);
  let vapid: Vapid | null;
  try {
    vapid = await vapidFromEnv(c.env);
  } catch (err) {
    console.error('VAPID keys are malformed', err);
    throw notConfigured();
  }
  if (!vapid) throw notConfigured();
  const all = await loadSubscriptions(c.env, c.var.user.id);
  const subs = body.endpoint ? all.filter((s) => s.endpoint === body.endpoint) : all;
  const { sent } = await sendToSubscriptions(c.env, subs, (lang) => ({ kind: 'test', ...testText(lang), url: '/settings', tag: 'test', lang }), vapid);
  return c.json({ sent });
});

pushRoutes.post('/skip', async (c) => {
  const { day } = await readJson(c, pushSkipSchema);
  await c.env.DB.prepare('INSERT OR IGNORE INTO reminder_skips (user_id, day) VALUES (?, ?)').bind(c.var.user.id, day).run();
  return c.body(null, 204);
});
