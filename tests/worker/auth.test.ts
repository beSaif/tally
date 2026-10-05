import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { api, cookieOf, signup } from './helpers';

describe('auth', () => {
  it('signs up, bootstraps, logs out', async () => {
    const s = await signup({ language: 'fr' });
    const me = await api('/api/auth/me', { cookie: s.cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string }; settings: { currency: string; setup_complete: boolean }; categories: Array<{ name: string }> };
    expect(body.user.email).toBe(s.email);
    expect(body.settings.currency).toBe('CHF');
    expect(body.settings.setup_complete).toBe(false);
    expect(body.categories.map((c) => c.name)).toEqual(['Courses', 'Restaurants', 'Transport', 'Maison', 'Santé', 'Loisirs', 'Shopping', 'Factures']);

    const out = await api('/api/auth/logout', { method: 'POST', cookie: s.cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/tally_session=;/);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(s.userId).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const after = await api('/api/auth/me', { cookie: s.cookie });
    expect(after.status).toBe(401);
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

  it('sets a secure, httponly, lax cookie over https', async () => {
    const res = await api('/api/auth/signup', { body: { email: `c-${Date.now()}@example.com`, password: 'password123', language: 'en' } });
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/Path=\//);
  });

  it('rejects duplicate emails and bad input', async () => {
    const s = await signup();
    const dup = await api('/api/auth/signup', { body: { email: s.email.toUpperCase(), password: 'password123', language: 'en' } });
    expect(dup.status).toBe(409);
    const short = await api('/api/auth/signup', { body: { email: 'x@example.com', password: 'short', language: 'en' } });
    expect(short.status).toBe(400);
    const notJson = await api('/api/auth/signup', { method: 'POST', raw: 'email=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(notJson.status).toBe(400);
  });

  it('logs in with the right password only, and throttles', async () => {
    const s = await signup({ password: 'right password' });
    const bad = await api('/api/auth/login', { body: { email: s.email, password: 'wrong password' } });
    expect(bad.status).toBe(401);
    const good = await api('/api/auth/login', { body: { email: s.email, password: 'right password' } });
    expect(good.status).toBe(200);
    expect(cookieOf(good)).toMatch(/^tally_session=/);

    for (let i = 0; i < 10; i++) await api('/api/auth/login', { body: { email: s.email, password: 'nope' } });
    const throttled = await api('/api/auth/login', { body: { email: s.email, password: 'right password' } });
    expect(throttled.status).toBe(429);
  });

  it('throttles per address, so failures elsewhere do not lock the owner out', async () => {
    const s = await signup({ password: 'right password' });
    const other = await signup({ password: 'right password' });
    const login = (email: string, password: string, ip: string) => api('/api/auth/login', { body: { email, password }, headers: { 'CF-Connecting-IP': ip } });

    for (let i = 0; i < 10; i++) expect((await login(s.email, 'nope', '203.0.113.7')).status).toBe(401);
    // That address is held off for this email, even with the right password…
    const held = await login(s.email, 'right password', '203.0.113.7');
    expect(held.status).toBe(429);
    expect(((await held.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    // …but not for another account, and the owner gets in from anywhere else.
    expect((await login(other.email, 'right password', '203.0.113.7')).status).toBe(200);
    expect((await login(s.email, 'right password', '2001:db8::1')).status).toBe(200);
    const rows = await env.DB.prepare('SELECT ip, COUNT(*) AS n FROM login_attempts WHERE email = ? GROUP BY ip').bind(s.email).all<{ ip: string; n: number }>();
    expect(rows.results).toEqual([{ ip: '203.0.113.7', n: 10 }]);
  });

  it('still bounds failures spread over many addresses', async () => {
    const s = await signup({ password: 'right password' });
    const login = (password: string, ip: string) => api('/api/auth/login', { body: { email: s.email, password }, headers: { 'CF-Connecting-IP': ip } });
    // Nine addresses with ten recent failures each, as a distributed guess would leave them.
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 90 }, (_, i) =>
        env.DB.prepare('INSERT INTO login_attempts (email, ip, attempted_at) VALUES (?, ?, ?)').bind(s.email, `192.0.2.${Math.floor(i / 10)}`, now - 60_000),
      ),
    );
    for (let i = 0; i < 9; i++) expect((await login('nope', '198.51.100.9')).status).toBe(401);
    // 99 failures: a fresh address still gets in (and its success clears nothing elsewhere).
    expect((await login('right password', '198.51.100.1')).status).toBe(200);
    // The hundredth closes the account to every address until the window passes.
    expect((await login('nope', '198.51.100.9')).status).toBe(401);
    expect((await login('right password', '198.51.100.2')).status).toBe(429);
    expect((await login('right password', '')).status).toBe(429);
  });

  it('refuses cross-origin mutations', async () => {
    const s = await signup();
    const res = await api('/api/auth/logout', { method: 'POST', cookie: s.cookie, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('changes password and revokes other sessions', async () => {
    const s = await signup({ password: 'first password' });
    const other = await api('/api/auth/login', { body: { email: s.email, password: 'first password' } });
    const otherCookie = cookieOf(other);
    const wrong = await api('/api/auth/password', { body: { current: 'bad', new: 'second password' }, cookie: s.cookie });
    expect(wrong.status).toBe(401);
    const ok = await api('/api/auth/password', { body: { current: 'first password', new: 'second password' }, cookie: s.cookie });
    expect(ok.status).toBe(204);
    expect((await api('/api/auth/me', { cookie: otherCookie })).status).toBe(401);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(200);
    expect((await api('/api/auth/login', { body: { email: s.email, password: 'second password' } })).status).toBe(200);
  });

  it('deletes the account and everything with it', async () => {
    const s = await signup({ password: 'delete me now' });
    const res = await api('/api/auth/account', { method: 'DELETE', body: { password: 'delete me now' }, cookie: s.cookie });
    expect(res.status).toBe(204);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(s.userId).first<{ n: number }>();
    expect(users?.n).toBe(0);
    const cats = await env.DB.prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id = ?').bind(s.userId).first<{ n: number }>();
    expect(cats?.n).toBe(0);
  });

  it('honours the invite code and the sign-up switch', async () => {
    // Bindings are static per test run, so this test only asserts the "open" defaults here;
    // the gated paths are covered by tests/worker/auth-gated.test.ts (separate config overrides).
    const res = await api('/api/auth/signup', { body: { email: `o-${Date.now()}@example.com`, password: 'password123', language: 'en', invite_code: 'anything' } });
    expect(res.status).toBe(201);
  });
});
