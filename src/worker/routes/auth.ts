import { Hono } from 'hono';
import type { Bootstrap, User } from '@shared/api';
import { DEFAULT_CATEGORIES, DEFAULT_CURRENCY, DEFAULT_MODEL } from '@shared/constants';
import { deleteAccountSchema, loginSchema, passwordChangeSchema, signupSchema } from '@shared/schemas';
import type { AppEnv } from '../env';
import { ApiError, readJson } from '../lib/http';
import { loadCategories, loadSettings, nowMs, uuid } from '../lib/db';
import {
  assertNotThrottled,
  clearAttempts,
  clearSessionCookie,
  constantTimeEqualString,
  createSession,
  deleteOtherSessions,
  deleteSession,
  hashPassword,
  recordFailedAttempt,
  requireUser,
  setSessionCookie,
  verifyPassword,
} from '../lib/auth';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

const toUser = (r: { id: string; email: string; created_at: number }): User => ({ id: r.id, email: r.email, created_at: r.created_at });

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/signup', async (c) => {
  const body = await readJson(c, signupSchema);
  if ((c.env.SIGNUPS_ENABLED ?? 'true').toLowerCase() === 'false') throw new ApiError('signups_disabled', 'Sign-ups are closed');
  const invite = c.env.INVITE_CODE;
  if (invite && !(body.invite_code && constantTimeEqualString(body.invite_code, invite))) {
    throw new ApiError('invite_required', 'An invite code is required');
  }
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(body.email).first<{ id: string }>();
  if (existing) throw new ApiError('email_taken', 'There is already an account for this email');

  const now = nowMs();
  const userId = uuid();
  const passwordHash = await hashPassword(body.password);
  const statements = [
    c.env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').bind(userId, body.email, passwordHash, now),
    c.env.DB.prepare(
      'INSERT INTO settings (user_id, currency, language, budget_cents, model, setup_complete, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 0, ?, ?)',
    ).bind(userId, DEFAULT_CURRENCY, 'auto', DEFAULT_MODEL, now, now),
    ...DEFAULT_CATEGORIES[body.language].map((name, i) =>
      c.env.DB.prepare('INSERT INTO categories (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').bind(uuid(), userId, name, i, now),
    ),
  ];
  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    // Two sign-ups racing on the same email: the UNIQUE constraint wins.
    if (String(err).includes('UNIQUE')) throw new ApiError('email_taken', 'There is already an account for this email');
    throw err;
  }
  const session = await createSession(c.env, userId, c.req.header('user-agent') ?? null);
  setSessionCookie(c, session.token, session.expiresAt);
  return c.json({ user: toUser({ id: userId, email: body.email, created_at: now }) }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = await readJson(c, loginSchema);
  await assertNotThrottled(c.env, body.email);
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(body.email).first<UserRow>();
  // Always run a hash verification so timing does not reveal whether the email exists.
  const ok = row ? await verifyPassword(body.password, row.password_hash) : await verifyPassword(body.password, DUMMY_HASH).then(() => false);
  if (!row || !ok) {
    await recordFailedAttempt(c.env, body.email);
    throw new ApiError('invalid_credentials', 'That email or password is not right');
  }
  await clearAttempts(c.env, body.email);
  const session = await createSession(c.env, row.id, c.req.header('user-agent') ?? null);
  setSessionCookie(c, session.token, session.expiresAt);
  return c.json({ user: toUser(row) });
});

authRoutes.post('/logout', async (c) => {
  const token = c.req.raw.headers.get('cookie') ? (await import('hono/cookie')).getCookie(c, 'tally_session') : undefined;
  if (token) await deleteSession(c.env, token);
  clearSessionCookie(c);
  return c.body(null, 204);
});

authRoutes.get('/me', requireUser, async (c) => {
  const user = c.var.user;
  const [settings, categories] = await Promise.all([loadSettings(c.env, user.id), loadCategories(c.env, user.id)]);
  if (!settings) throw new ApiError('internal', 'Settings missing for user');
  const body: Bootstrap = { user: toUser(user), settings, categories };
  return c.json(body);
});

authRoutes.post('/password', requireUser, async (c) => {
  const body = await readJson(c, passwordChangeSchema);
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.var.user.id).first<UserRow>();
  if (!row || !(await verifyPassword(body.current, row.password_hash))) {
    throw new ApiError('invalid_credentials', 'Current password is not right');
  }
  const hash = await hashPassword(body.new);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, row.id).run();
  await deleteOtherSessions(c.env, row.id, c.var.sessionToken);
  return c.body(null, 204);
});

authRoutes.delete('/account', requireUser, async (c) => {
  const body = await readJson(c, deleteAccountSchema);
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.var.user.id).first<UserRow>();
  if (!row || !(await verifyPassword(body.password, row.password_hash))) {
    throw new ApiError('invalid_credentials', 'Password is not right');
  }
  // Foreign keys cascade: sessions, settings, categories, entries, push subscriptions, logs.
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(row.id).run();
  clearSessionCookie(c);
  return c.body(null, 204);
});

// A valid-looking hash used to equalise timing when the email is unknown.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
