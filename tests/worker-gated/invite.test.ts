import { describe, expect, it } from 'vitest';
import { api } from '../worker/helpers';

describe('sign-up with INVITE_CODE set', () => {
  it('requires the right code', async () => {
    const no = await api('/api/auth/signup', { body: { email: `g1-${Date.now()}@example.com`, password: 'password123', language: 'en' } });
    expect(no.status).toBe(403);
    expect(((await no.json()) as { error: { code: string } }).error.code).toBe('invite_required');
    const wrong = await api('/api/auth/signup', { body: { email: `g2-${Date.now()}@example.com`, password: 'password123', language: 'en', invite_code: 'nope' } });
    expect(wrong.status).toBe(403);
    const ok = await api('/api/auth/signup', { body: { email: `g3-${Date.now()}@example.com`, password: 'password123', language: 'en', invite_code: 'letmein' } });
    expect(ok.status).toBe(201);
  });
});
