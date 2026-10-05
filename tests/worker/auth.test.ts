import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { api, claimsFor, cookieOf, finishSignIn, freshIdentity, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, idToken, mockTokenEndpoint, ORIGIN, signup, startSignIn } from './helpers';

const CALLBACK = `${ORIGIN}/api/auth/google/callback`;
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? -1;

describe('sign in with Google', () => {
  it('sends the browser to Google with PKCE, a state and a nonce, and keeps them in a cookie', async () => {
    const res = await api('/api/auth/google/start?lang=fr');
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location') ?? '');
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = to.searchParams;
    expect(q.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(CALLBACK);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('state')).toMatch(/^[\w-]{43}$/);
    expect(q.get('nonce')).toMatch(/^[\w-]{43}$/);
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);

    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^tally_oauth=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/Path=\/api\/auth\/google(;|$)/);
    expect(set).toMatch(/Max-Age=600/);
    // The cookie carries what Google will echo back, the verifier behind the challenge, and the language.
    const [state, nonce, verifier, lang] = decodeURIComponent(cookieOf(res, 'tally_oauth').slice('tally_oauth='.length)).split('.');
    expect(state).toBe(q.get('state'));
    expect(nonce).toBe(q.get('nonce'));
    expect(await sha256(verifier ?? '')).toBe(q.get('code_challenge'));
    expect(lang).toBe('fr');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('creates the account on the first sign-in, in the chosen language, and signs the browser in', async () => {
    const who = freshIdentity('first');
    const start = await startSignIn('fr');
    const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ ...who, nonce: start.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'the-code', state: start.state }, start.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');

      // The code went to Google with the client secret and the verifier behind the challenge.
      expect(google.calls).toHaveLength(1);
      const sent = google.calls[0]!;
      expect(sent.get('grant_type')).toBe('authorization_code');
      expect(sent.get('code')).toBe('the-code');
      expect(sent.get('client_id')).toBe(GOOGLE_CLIENT_ID);
      expect(sent.get('client_secret')).toBe(GOOGLE_CLIENT_SECRET);
      expect(sent.get('redirect_uri')).toBe(CALLBACK);
      expect(await sha256(sent.get('code_verifier') ?? '')).toBe(start.codeChallenge);

      // Signed in: a session cookie with the right flags, and the pending cookie is dropped.
      const set = res.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/tally_oauth=;[^,]*Max-Age=0/i);
      const session = set.slice(set.indexOf('tally_session='));
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).toMatch(/Secure/i);
      expect(session).toMatch(/Path=\//);

      const me = await api('/api/auth/me', { cookie: cookieOf(res) });
      expect(me.status).toBe(200);
      const body = (await me.json()) as { user: { id: string; email: string }; settings: { currency: string; setup_complete: boolean }; categories: Array<{ name: string }> };
      expect(body.user.email).toBe(who.email);
      expect(body.settings.currency).toBe('CHF');
      expect(body.settings.setup_complete).toBe(false);
      expect(body.categories.map((c) => c.name)).toEqual(['Courses', 'Restaurants', 'Transport', 'Maison', 'Santé', 'Loisirs', 'Shopping', 'Factures']);
      const row = await env.DB.prepare('SELECT google_sub FROM users WHERE id = ?').bind(body.user.id).first<{ google_sub: string }>();
      expect(row?.google_sub).toBe(who.sub);
    } finally {
      google.restore();
    }
  });

  it('recognises the account next time, follows a changed address, and replaces the session it signs in over', async () => {
    const first = await signup();
    const again = await signup({ sub: first.sub, email: first.email });
    expect(again.userId).toBe(first.userId);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?', first.sub)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', first.userId)).toBe(2);

    // The person renamed their Google account; this browser already held `again`'s session.
    const moved = await signup({ sub: first.sub, email: `new-${first.email}`, cookie: again.cookie });
    expect(moved.userId).toBe(first.userId);
    const me = (await (await api('/api/auth/me', { cookie: moved.cookie })).json()) as { user: { email: string } };
    expect(me.user.email).toBe(`new-${first.email}`);
    expect((await api('/api/auth/me', { cookie: again.cookie })).status).toBe(401);
    expect((await api('/api/auth/me', { cookie: first.cookie })).status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', first.userId)).toBe(2);
  });

  it('stores the address trimmed and lower-cased', async () => {
    const who = freshIdentity('case');
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ sub: who.sub, email: ` ${who.email.toUpperCase()} `, nonce: start.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
      const me = (await (await api('/api/auth/me', { cookie: cookieOf(res) })).json()) as { user: { email: string } };
      expect(me.user.email).toBe(who.email);
    } finally {
      google.restore();
    }
  });

  it('never hands an address that belongs to one account to another Google account', async () => {
    const owner = await signup();
    const other = freshIdentity('other');
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ sub: other.sub, email: owner.email, nonce: start.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
      expect(res.headers.get('location')).toBe('/login?error=failed');
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/tally_session=/);
      expect(await count('SELECT COUNT(*) AS n FROM users WHERE email = ?', owner.email)).toBe(1);
      expect(await count('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?', other.sub)).toBe(0);
    } finally {
      google.restore();
    }
  });

  it('refuses a callback without its cookie, with a foreign state, without a code, or after a cancel at Google', async () => {
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ status: 500, body: { error: 'must not be asked' } }));
    try {
      const noCookie = await finishSignIn({ code: 'c', state: start.state }, '');
      expect(noCookie.status).toBe(302);
      expect(noCookie.headers.get('location')).toBe('/login?error=failed');
      const wrongState = await finishSignIn({ code: 'c', state: 'someone-elses' }, start.cookie);
      expect(wrongState.headers.get('location')).toBe('/login?error=failed');
      const noCode = await finishSignIn({ state: start.state }, start.cookie);
      expect(noCode.headers.get('location')).toBe('/login?error=failed');
      const cancelled = await finishSignIn({ error: 'access_denied', state: start.state }, start.cookie);
      expect(cancelled.headers.get('location')).toBe('/login?error=cancelled');
      for (const res of [noCookie, wrongState, noCode, cancelled]) {
        expect(res.headers.get('set-cookie') ?? '').not.toMatch(/tally_session=/);
        expect(res.headers.get('set-cookie') ?? '').toMatch(/tally_oauth=;[^,]*Max-Age=0/i);
      }
      expect(google.calls).toHaveLength(0);
    } finally {
      google.restore();
    }
  });

  it('refuses an ID token that is not for us, stale, for another sign-in, or without a verified address', async () => {
    const who = freshIdentity('bad');
    const cases: Array<[string, (good: Record<string, unknown>) => Record<string, unknown>]> = [
      ['another audience', (g) => ({ ...g, aud: 'someone-else' })],
      ['another issuer', (g) => ({ ...g, iss: 'https://accounts.evil.example' })],
      ['expired', (g) => ({ ...g, exp: Math.floor(Date.now() / 1000) - 1 })],
      ['another nonce', (g) => ({ ...g, nonce: 'not-this-sign-in' })],
      ['unverified address', (g) => ({ ...g, email_verified: false })],
      ['no subject', (g) => ({ ...g, sub: '' })],
      ['no address', (g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'email'))],
    ];
    for (const [name, mutate] of cases) {
      const start = await startSignIn();
      const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(mutate(claimsFor({ ...who, nonce: start.nonce }))) } }));
      try {
        const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
        expect(res.headers.get('location'), name).toBe('/login?error=failed');
        expect(res.headers.get('set-cookie') ?? '', name).not.toMatch(/tally_session=/);
      } finally {
        google.restore();
      }
    }
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE email = ?', who.email)).toBe(0);
  });

  it('fails cleanly when Google refuses the code or answers nonsense', async () => {
    for (const answer of [{ status: 400, body: { error: 'invalid_grant' } }, { body: { id_token: 'not.a.jwt' } }, { body: 'plain text' }]) {
      const start = await startSignIn();
      const google = mockTokenEndpoint(() => answer);
      try {
        const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
        expect(res.headers.get('location')).toBe('/login?error=failed');
      } finally {
        google.restore();
      }
    }
  });
});

describe('sessions', () => {
  it('bootstraps and logs out', async () => {
    const s = await signup({ language: 'en' });
    const me = await api('/api/auth/me', { cookie: s.cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string }; categories: Array<{ name: string }> };
    expect(body.user.email).toBe(s.email);
    expect(body.categories.map((c) => c.name)).toEqual(['Groceries', 'Dining', 'Transport', 'Home', 'Health', 'Fun', 'Shopping', 'Bills']);

    const out = await api('/api/auth/logout', { method: 'POST', cookie: s.cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/tally_session=;/);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(0);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(401);
  });

  it('logs out without a session too', async () => {
    const out = await api('/api/auth/logout', { method: 'POST' });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/tally_session=;/);
  });

  it('renews a session that runs low once, not on every request', async () => {
    const DAY = 86_400_000;
    const s = await signup();
    const expiry = async () => (await env.DB.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').bind(s.userId).first<{ expires_at: number }>())?.expires_at;

    // Twenty days left: nothing to do.
    const plenty = Date.now() + 20 * DAY;
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(plenty, s.userId).run();
    const untouched = await api('/api/auth/me', { cookie: s.cookie });
    expect(untouched.status).toBe(200);
    expect(untouched.headers.get('set-cookie')).toBeNull();
    expect(await expiry()).toBe(plenty);

    // Ten days left: renewed to thirty, cookie included…
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(Date.now() + 10 * DAY, s.userId).run();
    const renewed = await api('/api/auth/me', { cookie: s.cookie });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('set-cookie')).toMatch(/tally_session=/);
    const after = await expiry();
    expect(after).toBeGreaterThan(Date.now() + 29 * DAY);

    // …and the next request the same day writes nothing.
    const next = await api('/api/auth/me', { cookie: s.cookie });
    expect(next.status).toBe(200);
    expect(next.headers.get('set-cookie')).toBeNull();
    expect(await expiry()).toBe(after);
  });

  it('refuses cross-origin mutations', async () => {
    const s = await signup();
    const res = await api('/api/auth/logout', { method: 'POST', cookie: s.cookie, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('deletes the account when its email is typed right, and everything with it', async () => {
    const s = await signup();
    const wrong = await api('/api/auth/account', { method: 'DELETE', body: { email: 'someone@else.example' }, cookie: s.cookie });
    expect(wrong.status).toBe(400);
    const notJson = await api('/api/auth/account', { method: 'DELETE', raw: 'email=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cookie: s.cookie });
    expect(notJson.status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', s.userId)).toBe(1);

    const res = await api('/api/auth/account', { method: 'DELETE', body: { email: s.email.toUpperCase() }, cookie: s.cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/tally_session=;/);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', s.userId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM categories WHERE user_id = ?', s.userId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(0);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(401);
  });
});
