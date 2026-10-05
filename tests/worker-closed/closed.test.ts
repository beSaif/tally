import { describe, expect, it } from 'vitest';
import { api } from '../worker/helpers';

describe('sign-up with SIGNUPS_ENABLED=false', () => {
  it('is refused', async () => {
    const res = await api('/api/auth/signup', { body: { email: `c-${Date.now()}@example.com`, password: 'password123', language: 'en' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('signups_disabled');
  });
});
