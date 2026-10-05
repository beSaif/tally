/**
 * Test helpers for push: a fake subscriber (real P-256 keys, so payloads can be decrypted the
 * way a browser would), a mocked push service, and direct D1 seeding (the entries/settings
 * routes are not needed to exercise the push code).
 */
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { PushPayload } from '@shared/api';
import { b64url } from '../../src/worker/lib/auth';

const te = new TextEncoder();
const td = new TextDecoder();
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => te.encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Subscriber {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateKey: CryptoKey;
  publicRaw: Uint8Array<ArrayBuffer>;
  authBytes: Uint8Array<ArrayBuffer>;
}

/** What a browser's PushManager would hand out: an endpoint, a P-256 key pair and a 16-byte auth secret. */
export async function makeSubscriber(endpoint: string): Promise<Subscriber> {
  const pair = (await crypto.subtle.generateKey(ECDH_P256, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, p256dh: b64url(publicRaw), auth: b64url(authBytes), privateKey: pair.privateKey, publicRaw, authBytes };
}

async function hmacSha256(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** RFC 5869 HKDF from HMAC (L ≤ 32), independent of WebCrypto's HKDF used by the code under test. */
async function hkdfViaHmac(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmacSha256(salt, ikm);
  const t1 = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return t1.slice(0, length);
}

export interface Decrypted {
  plaintext: Uint8Array<ArrayBuffer>;
  delimiter: number;
  recordSize: number;
  keyIdLength: number;
}

/** The receiving side of RFC 8291 (what the browser does with an aes128gcm push body). */
export async function decryptPushBody(body: Uint8Array<ArrayBuffer>, sub: Pick<Subscriber, 'privateKey' | 'publicRaw' | 'authBytes'>): Promise<Decrypted> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16);
  const keyIdLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);

  const asKey = await crypto.subtle.importKey('raw', asPublic, ECDH_P256, false, []);
  const algorithm = { name: 'ECDH', public: asKey };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(algorithm, sub.privateKey, 256));
  const ikm = await hkdfViaHmac(sub.authBytes, shared, concat(utf8('WebPush: info\0'), sub.publicRaw, asPublic), 32);
  const cek = await hkdfViaHmac(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfViaHmac(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));

  // Padding is zeros after the delimiter; the delimiter is the last non-zero byte.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  return { plaintext: record.slice(0, end), delimiter: record[end] ?? -1, recordSize, keyIdLength };
}

export interface CapturedPush {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * Replaces the global fetch the Worker uses to reach push services (the Worker under test runs
 * in this isolate) and records every request. Restore with `vi.restoreAllMocks()`.
 */
export function mockPushService(status: number | ((url: string) => number) = 201): CapturedPush[] {
  const calls: CapturedPush[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(null, { status: typeof status === 'function' ? status(req.url) : status });
  });
  return calls;
}

export async function decryptPayload(call: CapturedPush, sub: Subscriber): Promise<PushPayload> {
  const { plaintext } = await decryptPushBody(call.body, sub);
  return JSON.parse(td.decode(plaintext)) as PushPayload;
}

/** Calls to one subscriber, decrypted. */
export async function payloadsFor(calls: CapturedPush[], sub: Subscriber): Promise<PushPayload[]> {
  return Promise.all(calls.filter((c) => c.url === sub.endpoint).map((c) => decryptPayload(c, sub)));
}

// ---- D1 seeding ----

/** Storage is shared by the tests of one file, so suites that scan every user start clean. */
export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ['notification_log', 'reminder_skips', 'push_subscriptions', 'entries', 'categories', 'settings', 'sessions', 'users'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

export type SettingsSeed = Partial<{
  currency: string;
  budget_cents: number | null;
  notif_reminder: number;
  notif_reminder_time: string;
  notif_reminder_only_if_empty: number;
  notif_budget: number;
  notif_weekly: number;
  notif_monthly: number;
}>;

/** A user with default settings (schema defaults), adjusted by `settings`. */
export async function seedUser(settings: SettingsSeed = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').bind(id, `${id}@example.com`, 'unused', now),
    env.DB.prepare('INSERT INTO settings (user_id, created_at, updated_at) VALUES (?, ?, ?)').bind(id, now, now),
  ]);
  await setSettings(id, settings);
  return id;
}

export async function setSettings(userId: string, settings: SettingsSeed): Promise<void> {
  const cols = Object.keys(settings) as Array<keyof SettingsSeed>;
  if (cols.length === 0) return;
  // Column names come from the typed keys above, never from input.
  await env.DB.prepare(`UPDATE settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ?`)
    .bind(...cols.map((c) => settings[c] ?? null), userId)
    .run();
}

export async function addCategory(userId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO categories (id, user_id, name, position, created_at) VALUES (?, ?, ?, 0, ?)').bind(id, userId, name, Date.now()).run();
  return id;
}

export interface EntrySeed {
  amount_cents: number;
  occurred_at: string;
  category_id?: string | null;
  description?: string;
}

export async function addEntries(userId: string, entries: EntrySeed[]): Promise<void> {
  const now = Date.now();
  await env.DB.batch(
    entries.map((e) =>
      env.DB.prepare(
        "INSERT INTO entries (id, user_id, amount_cents, currency, description, category_id, occurred_at, source, created_at, updated_at) VALUES (?, ?, ?, 'CHF', ?, ?, ?, 'manual', ?, ?)",
      ).bind(crypto.randomUUID(), userId, e.amount_cents, e.description ?? 'Something', e.category_id ?? null, e.occurred_at, now, now),
    ),
  );
}

export async function addSubscription(
  userId: string,
  sub: Pick<Subscriber, 'endpoint' | 'p256dh' | 'auth'>,
  opts: { tz?: string; lang?: 'en' | 'fr'; failures?: number; lastSeenAt?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, lang, tz, created_at, last_seen_at, failures) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, sub.endpoint, sub.p256dh, sub.auth, opts.lang ?? 'en', opts.tz ?? 'UTC', now, opts.lastSeenAt ?? now, opts.failures ?? 0)
    .run();
  return id;
}

export async function subscriptionRow(id: string): Promise<{ failures: number; last_seen_at: number; lang: string; tz: string } | null> {
  return env.DB.prepare('SELECT failures, last_seen_at, lang, tz FROM push_subscriptions WHERE id = ?').bind(id).first();
}

export async function logKeys(userId: string, kind: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT period_key FROM notification_log WHERE user_id = ? AND kind = ? ORDER BY period_key').bind(userId, kind).all<{ period_key: string }>();
  return results.map((r) => r.period_key);
}
