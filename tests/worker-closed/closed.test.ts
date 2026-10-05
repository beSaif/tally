import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { api, claimsFor, cookieOf, finishSignIn, freshIdentity, idToken, mockTokenEndpoint, startSignIn } from '../worker/helpers';

describe('sign-in with SIGNUPS_ENABLED=false', () => {
  it('turns new Google accounts away but lets existing ones in', async () => {
    const stranger = freshIdentity('stranger');
    const first = await startSignIn();
    const refused = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ ...stranger, nonce: first.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: first.state }, first.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=signups_disabled');
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/tally_session=/);
    } finally {
      refused.restore();
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);

    // An account made while sign-ups were open still signs in.
    const member = freshIdentity('member');
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)').bind('u-member', member.sub, member.email, now),
      env.DB.prepare('INSERT INTO settings (user_id, created_at, updated_at) VALUES (?, ?, ?)').bind('u-member', now, now),
    ]);
    const second = await startSignIn();
    const welcomed = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ ...member, nonce: second.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: second.state }, second.cookie);
      expect(res.headers.get('location')).toBe('/');
      expect((await api('/api/auth/me', { cookie: cookieOf(res) })).status).toBe(200);
    } finally {
      welcomed.restore();
    }
  });
});
