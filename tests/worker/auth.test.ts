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
    const after = await api('/api/auth/me', { cookie: s.cookie });
    expect(after.status).toBe(401);
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
