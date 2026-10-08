import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Bootstrap, ResolvedLanguage, SignInError, User } from '@shared/api';
import { DEFAULT_CATEGORIES, DEFAULT_CURRENCY, DEFAULT_MODEL, FIXED_CATEGORIES, OAUTH_COOKIE, OAUTH_COOKIE_SECONDS } from '@shared/constants';
import { deleteAccountSchema } from '@shared/schemas';
import type { AppEnv, Env, SessionUser } from '../env';
import { ApiError, readJson } from '../lib/http';
import { loadCategories, loadSettings, nowMs, uuid } from '../lib/db';
import {
  clearSessionCookie,
  constantTimeEqualString,
  createSession,
  deleteSession,
  getSessionToken,
  randomToken,
  requireUser,
  setSessionCookie,
} from '../lib/auth';
import { authorizeUrl, exchangeCode, googleClient, identityFromIdToken, pkceChallenge, type GoogleIdentity } from '../lib/google';

interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  created_at: number;
}

const toSessionUser = (r: UserRow): SessionUser => ({ id: r.id, email: r.email, created_at: r.created_at });
const toUser = (r: SessionUser): User => ({ id: r.id, email: r.email, created_at: r.created_at });

export const authRoutes = new Hono<AppEnv>();

const CALLBACK_PATH = '/api/auth/google/callback';
/** The pending-sign-in cookie is only ever sent back to the callback. */
const OAUTH_COOKIE_PATH = '/api/auth/google';

/** What the browser keeps between leaving for Google and coming back, as `state.nonce.verifier.lang`. */
interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  lang: ResolvedLanguage;
}

const encodePending = (p: PendingSignIn): string => [p.state, p.nonce, p.verifier, p.lang].join('.');

function decodePending(raw: string | undefined): PendingSignIn | null {
  const [state, nonce, verifier, lang, ...rest] = raw?.split('.') ?? [];
  if (!state || !nonce || !verifier || (lang !== 'en' && lang !== 'fr') || rest.length) return null;
  return { state, nonce, verifier, lang };
}

const isHttps = (c: Context<AppEnv>): boolean => new URL(c.req.url).protocol === 'https:';
const callbackUri = (c: Context<AppEnv>): string => new URL(CALLBACK_PATH, c.req.url).toString();
const notConfigured = () => new ApiError('internal', 'Google sign-in is not configured on this server');
/** Back to the login screen, which explains the code. */
const signInFailed = (c: Context<AppEnv>, error: SignInError) => c.redirect(`/login?error=${error}`, 302);

// Step 1: remember state, nonce and PKCE verifier in a short-lived cookie, send the browser to Google.
authRoutes.get('/google/start', async (c) => {
  const client = googleClient(c.env);
  if (!client) throw notConfigured();
  const pending: PendingSignIn = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    lang: c.req.query('lang') === 'fr' ? 'fr' : 'en',
  };
  setCookie(c, OAUTH_COOKIE, encodePending(pending), {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_SECONDS,
  });
  const url = authorizeUrl(client, {
    redirectUri: callbackUri(c),
    state: pending.state,
    nonce: pending.nonce,
    codeChallenge: await pkceChallenge(pending.verifier),
  });
  return c.redirect(url, 302);
});

// Step 2: Google sent the browser back. Check the state, swap the code, read the identity, sign in.
authRoutes.get('/google/callback', async (c) => {
  const client = googleClient(c.env);
  if (!client) throw notConfigured();
  const pending = decodePending(getCookie(c, OAUTH_COOKIE));
  deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH, secure: isHttps(c), httpOnly: true, sameSite: 'Lax' });
  // `error=access_denied`: the person backed out of Google's account chooser.
  if (c.req.query('error')) return signInFailed(c, 'cancelled');
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!pending || !code || !state || !constantTimeEqualString(state, pending.state)) return signInFailed(c, 'failed');
  const idToken = await exchangeCode(client, { code, redirectUri: callbackUri(c), codeVerifier: pending.verifier });
  const identity = idToken ? identityFromIdToken(idToken, { clientId: client.clientId, nonce: pending.nonce }) : null;
  if (!identity) return signInFailed(c, 'failed');
  const found = await findOrCreateUser(c.env, identity, pending.lang);
  if ('error' in found) return signInFailed(c, found.error);
  // Signing in over an existing session replaces it.
  const previous = getSessionToken(c);
  if (previous) await deleteSession(c.env, previous);
  const session = await createSession(c.env, found.user.id, c.req.header('user-agent') ?? null);
  setSessionCookie(c, session.token, session.expiresAt);
  return c.redirect('/', 302);
});

type Found = { user: SessionUser } | { error: SignInError };

/** The account for this Google identity, created on first sign-in unless sign-ups are closed. */
async function findOrCreateUser(env: Env, who: GoogleIdentity, lang: ResolvedLanguage): Promise<Found> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(who.sub).first<UserRow>();
  if (existing) return { user: await followEmail(env, existing, who.email) };
  if ((env.SIGNUPS_ENABLED ?? 'true').toLowerCase() === 'false') return { error: 'signups_disabled' };
  const now = nowMs();
  const id = uuid();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)').bind(id, who.sub, who.email, now),
      env.DB.prepare(
        'INSERT INTO settings (user_id, currency, language, budget_cents, model, setup_complete, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 0, ?, ?)',
      ).bind(id, DEFAULT_CURRENCY, 'auto', DEFAULT_MODEL, now, now),
      ...DEFAULT_CATEGORIES[lang].map((name, i) =>
        env.DB.prepare('INSERT INTO categories (id, user_id, name, position, fixed, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
          uuid(),
          id,
          name,
          i,
          FIXED_CATEGORIES.includes(name) ? 1 : 0,
          now,
        ),
      ),
    ]);
  } catch (err) {
    if (!String(err).includes('UNIQUE')) throw err;
    // Two first sign-ins racing: the other one made the account, use it. The only other way here is
    // an address that already belongs to a different Google account; that sign-in fails rather than
    // handing over someone else's data.
    const made = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(who.sub).first<UserRow>();
    if (!made) {
      console.error('Sign-in refused: the address belongs to another account');
      return { error: 'failed' };
    }
    return { user: toSessionUser(made) };
  }
  return { user: { id, email: who.email, created_at: now } };
}

/** The address on the Google account changed: follow it, unless another account already has it. */
async function followEmail(env: Env, row: UserRow, email: string): Promise<SessionUser> {
  if (row.email === email) return toSessionUser(row);
  const moved = await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
    .bind(email, row.id)
    .run()
    .then(
      () => true,
      (err: unknown) => {
        if (!String(err).includes('UNIQUE')) throw err;
        return false;
      },
    );
  return { id: row.id, email: moved ? email : row.email, created_at: row.created_at };
}

authRoutes.post('/logout', async (c) => {
  const token = getSessionToken(c);
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

authRoutes.delete('/account', requireUser, async (c) => {
  const body = await readJson(c, deleteAccountSchema);
  // Typed again as confirmation (the app keeps the button disabled until it matches).
  if (body.email !== c.var.user.email) throw new ApiError('validation', 'Type the email of this account to confirm');
  // Foreign keys cascade: sessions, settings, categories, entries, push subscriptions, logs.
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.var.user.id).run();
  clearSessionCookie(c);
  return c.body(null, 204);
});
