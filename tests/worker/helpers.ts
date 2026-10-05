import { vi } from 'vitest';
import { SELF } from 'cloudflare:test';

export const ORIGIN = 'https://tally.test';
/** Must match TEST_GOOGLE in vitest.worker.config.ts. */
export const GOOGLE_CLIENT_ID = 'tally-test-client';
export const GOOGLE_CLIENT_SECRET = 'tally-test-secret';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface Session {
  cookie: string;
  userId: string;
  email: string;
  /** The Google account id this session signed in with. */
  sub: string;
}

/** Fetch against the Worker with JSON body and (optionally) cookies. Redirects are returned, not followed. */
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
  return SELF.fetch(`${ORIGIN}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
}

/** One cookie a response sets, as `name=value` (the session cookie by default). */
export function cookieOf(res: Response, name = 'tally_session'): string {
  const set = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${name}=([^;]+)`).exec(set);
  if (!m) throw new Error(`no ${name} cookie in: ${set}`);
  return `${name}=${m[1]}`;
}

const b64url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** An ID token as Google mints it, minus a real signature: the Worker trusts the channel, not the signature. */
export function idToken(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'test', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('signature')}`;
}

export interface ClaimOptions {
  sub: string;
  email: string;
  nonce: string;
}

/** The claims of a good token for this sign-in. */
export function claimsFor(o: ClaimOptions): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: o.sub, email: o.email, email_verified: true, nonce: o.nonce, iat: now, exp: now + 3600 };
}

export interface Started {
  location: URL;
  /** The pending-sign-in cookie, as the browser would send it back. */
  cookie: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Step 1 of a sign-in: where the Worker sends the browser, and the cookie it hands it. */
export async function startSignIn(lang: 'en' | 'fr' = 'en', init: { cookie?: string } = {}): Promise<Started> {
  const res = await api(`/api/auth/google/start?lang=${lang}`, { cookie: init.cookie });
  if (res.status !== 302) throw new Error(`start: ${res.status} ${await res.text()}`);
  const location = new URL(res.headers.get('location') ?? '');
  const q = location.searchParams;
  return { location, cookie: cookieOf(res, 'tally_oauth'), state: q.get('state') ?? '', nonce: q.get('nonce') ?? '', codeChallenge: q.get('code_challenge') ?? '' };
}

export interface TokenAnswer {
  status?: number;
  body: unknown;
}
export interface TokenEndpoint {
  /** What the Worker posted, one entry per exchange. */
  calls: URLSearchParams[];
  restore(): void;
}

/** Stands in for Google's token endpoint, the Worker's only outbound call during a sign-in, until restored. */
export function mockTokenEndpoint(answer: (sent: URLSearchParams) => TokenAnswer): TokenEndpoint {
  const calls: URLSearchParams[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch during sign-in: ${url}`);
    const sent = new URLSearchParams(String(init?.body ?? ''));
    calls.push(sent);
    const a = answer(sent);
    return Response.json(a.body, { status: a.status ?? 200 });
  });
  return { calls, restore: () => spy.mockRestore() };
}

/** Step 2: the browser comes back from Google. `cookies` is what it holds (the pending cookie, maybe a session). */
export function finishSignIn(params: Record<string, string>, cookies: string): Promise<Response> {
  return api(`/api/auth/google/callback?${new URLSearchParams(params).toString()}`, { cookie: cookies || undefined });
}

let counter = 0;
/** A Google account nobody has signed in with yet. */
export function freshIdentity(tag = 'user'): { sub: string; email: string } {
  counter += 1;
  return { sub: `sub-${tag}-${counter}-${Date.now()}`, email: `${tag}${counter}-${Date.now()}@example.com` };
}

/**
 * Signs in through the whole flow against a stand-in token endpoint. A brand-new Google account by
 * default, so this creates the Tally account too, which is what most tests want.
 */
export async function signup(opts: { email?: string; sub?: string; language?: 'en' | 'fr'; cookie?: string } = {}): Promise<Session> {
  const fresh = freshIdentity();
  const sub = opts.sub ?? fresh.sub;
  const email = opts.email ?? fresh.email;
  const start = await startSignIn(opts.language ?? 'en', { cookie: opts.cookie });
  const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ sub, email, nonce: start.nonce })), access_token: 'x', token_type: 'Bearer', expires_in: 3600 } }));
  try {
    const res = await finishSignIn({ code: `code-${counter}`, state: start.state }, [start.cookie, opts.cookie].filter(Boolean).join('; '));
    if (res.status !== 302 || res.headers.get('location') !== '/') throw new Error(`sign-in failed: ${res.status} → ${res.headers.get('location')} ${await res.text()}`);
    const cookie = cookieOf(res);
    const me = await api('/api/auth/me', { cookie });
    if (me.status !== 200) throw new Error(`me after sign-in: ${me.status}`);
    const json = (await me.json()) as { user: { id: string } };
    return { cookie, userId: json.user.id, email, sub };
  } finally {
    google.restore();
  }
}
