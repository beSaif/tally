import { SELF } from 'cloudflare:test';

export const ORIGIN = 'https://tally.test';

export interface Session {
  cookie: string;
  userId: string;
  email: string;
}

/** Fetch against the Worker with JSON body and (optionally) a session cookie. */
export async function api(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: BodyInit } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Origin: ORIGIN, ...(init.headers ?? {}) };
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  if (init.cookie) headers['Cookie'] = init.cookie;
  const res = await SELF.fetch(`${ORIGIN}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  return res;
}

export function cookieOf(res: Response): string {
  const set = res.headers.get('set-cookie') ?? '';
  const m = /tally_session=([^;]+)/.exec(set);
  if (!m) throw new Error(`no session cookie in: ${set}`);
  return `tally_session=${m[1]}`;
}

let counter = 0;
export async function signup(opts: { email?: string; password?: string; language?: 'en' | 'fr'; invite_code?: string } = {}): Promise<Session> {
  const email = opts.email ?? `user${++counter}-${Date.now()}@example.com`;
  const password = opts.password ?? 'correct horse battery';
  const res = await api('/api/auth/signup', { body: { email, password, language: opts.language ?? 'en', invite_code: opts.invite_code } });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), userId: json.user.id, email };
}
