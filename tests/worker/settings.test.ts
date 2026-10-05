import { describe, expect, it } from 'vitest';
import type { ApiErrorBody, Bootstrap, Settings, SettingsInput } from '@shared/api';
import { DEFAULT_MODEL } from '@shared/constants';
import { api, signup, type Session } from './helpers';

const DEFAULTS: Omit<Settings, 'updated_at'> = {
  currency: 'CHF',
  language: 'auto',
  budget_cents: null,
  model: DEFAULT_MODEL,
  setup_complete: false,
  notifications: {
    reminder: false,
    reminder_time: '20:30',
    reminder_only_if_empty: true,
    budget: true,
    weekly: true,
    monthly: true,
  },
};

async function get(s: Session): Promise<Settings> {
  const res = await api('/api/settings', { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as { settings: Settings }).settings;
}

async function put(s: Session, body: unknown): Promise<Response> {
  return api('/api/settings', { method: 'PUT', body, cookie: s.cookie });
}

async function update(s: Session, input: SettingsInput): Promise<Settings> {
  const res = await put(s, input);
  expect(res.status).toBe(200);
  const { settings } = (await res.json()) as { settings: Settings };
  expect(await get(s)).toEqual(settings);
  return settings;
}

async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return ((await res.json()) as ApiErrorBody).error;
}

describe('settings', () => {
  it('requires a session', async () => {
    expect((await api('/api/settings')).status).toBe(401);
    const res = await api('/api/settings', { method: 'PUT', body: { currency: 'EUR' } });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('unauthorized');
  });

  it('starts from the defaults', async () => {
    const s = await signup();
    const settings = await get(s);
    expect(settings).toEqual({ ...DEFAULTS, updated_at: settings.updated_at });
    expect(settings.updated_at).toBeTypeOf('number');
  });

  it('changes only what is sent and bumps updated_at', async () => {
    const s = await signup();
    const before = await get(s);
    const after = await update(s, { currency: 'EUR' });
    expect(after).toEqual({ ...before, currency: 'EUR', updated_at: after.updated_at });
    expect(after.updated_at).toBeGreaterThan(before.updated_at);

    const touched = await update(s, {});
    expect(touched).toEqual({ ...after, updated_at: touched.updated_at });
    expect(touched.updated_at).toBeGreaterThan(after.updated_at);
  });

  it('merges notification preferences field by field', async () => {
    const s = await signup();
    const first = await update(s, { notifications: { reminder: true, reminder_time: '07:45' } });
    expect(first.notifications).toEqual({ ...DEFAULTS.notifications, reminder: true, reminder_time: '07:45' });
    const second = await update(s, { notifications: { weekly: false, reminder_only_if_empty: false } });
    expect(second.notifications).toEqual({
      reminder: true,
      reminder_time: '07:45',
      reminder_only_if_empty: false,
      budget: true,
      weekly: false,
      monthly: true,
    });
    const third = await update(s, { notifications: { budget: false, monthly: false, reminder: false } });
    expect(third.notifications).toEqual({ ...second.notifications, budget: false, monthly: false, reminder: false });
    expect(third.currency).toBe('CHF');
  });

  it('sets and clears the budget', async () => {
    const s = await signup();
    expect((await update(s, { budget_cents: 200_000 })).budget_cents).toBe(200_000);
    expect((await update(s, { currency: 'EUR' })).budget_cents).toBe(200_000);
    expect((await update(s, { budget_cents: 0 })).budget_cents).toBe(0);
    expect((await update(s, { budget_cents: 1_000_000_000 })).budget_cents).toBe(1_000_000_000);
    expect((await update(s, { budget_cents: null })).budget_cents).toBeNull();
  });

  it('completes setup in one call, visible in the bootstrap', async () => {
    const s = await signup();
    const settings = await update(s, {
      currency: 'USD',
      language: 'fr',
      budget_cents: 150_000,
      model: '  gemini-2.5-pro  ',
      setup_complete: true,
      notifications: { reminder: true },
    });
    expect(settings).toMatchObject({ currency: 'USD', language: 'fr', budget_cents: 150_000, model: 'gemini-2.5-pro', setup_complete: true });
    const me = (await (await api('/api/auth/me', { cookie: s.cookie })).json()) as Bootstrap;
    expect(me.settings).toEqual(settings);
  });

  it('validates every field and changes nothing on error', async () => {
    const s = await signup();
    const before = await get(s);
    const bad: Array<[unknown, string]> = [
      [{ currency: 'chf' }, 'currency'],
      [{ currency: 'EURO' }, 'currency'],
      [{ language: 'de' }, 'language'],
      [{ budget_cents: -1 }, 'budget_cents'],
      [{ budget_cents: 12.5 }, 'budget_cents'],
      [{ budget_cents: 1_000_000_001 }, 'budget_cents'],
      [{ budget_cents: '100' }, 'budget_cents'],
      [{ model: '' }, 'model'],
      [{ model: '   ' }, 'model'],
      [{ model: 'm'.repeat(81) }, 'model'],
      [{ setup_complete: 1 }, 'setup_complete'],
      [{ notifications: { reminder_time: '24:00' } }, 'notifications.reminder_time'],
      [{ notifications: { reminder_time: '7:30' } }, 'notifications.reminder_time'],
      [{ notifications: { reminder: 'yes' } }, 'notifications.reminder'],
      [{ notifications: true }, 'notifications'],
      // The first invalid field rejects the whole update, valid siblings included.
      [{ currency: 'GBP', language: 'xx' }, 'language'],
    ];
    for (const [body, path] of bad) {
      const res = await put(s, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const err = await errorOf(res);
      expect(err.code).toBe('validation');
      expect(err.message.startsWith(`${path}:`), err.message).toBe(true);
    }
    const notJson = await api('/api/settings', { method: 'PUT', raw: 'currency=EUR', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cookie: s.cookie });
    expect(notJson.status).toBe(400);
    const broken = await api('/api/settings', { method: 'PUT', raw: '{"currency":', headers: { 'Content-Type': 'application/json' }, cookie: s.cookie });
    expect(broken.status).toBe(400);
    expect(await get(s)).toEqual(before);
  });

  it("only changes the caller's settings", async () => {
    const a = await signup();
    const b = await signup();
    const bBefore = await get(b);
    await update(a, { currency: 'JPY', budget_cents: 5_000_000, notifications: { reminder: true } });
    expect(await get(b)).toEqual(bBefore);
  });
});
