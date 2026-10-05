/**
 * Web Push from a Worker with WebCrypto only (no Node APIs, no dependencies):
 * - VAPID (RFC 8292): an ES256 JWT that identifies this server to the push service.
 * - Message encryption (RFC 8291) in the aes128gcm content coding (RFC 8188).
 * The primitives are exported so tests can check them against the RFC 8291 Appendix A vector.
 */
import type { PushPayload } from '@shared/api';
import type { Env } from '../env';
import { b64url } from '../lib/auth';

const enc = new TextEncoder();

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' };

/** One record that holds the whole message; RFC 8291 §4 has senders use a single record. */
const RECORD_SIZE = 4096;
const SALT_LENGTH = 16;
const PUBLIC_KEY_LENGTH = 65; // uncompressed P-256 point: 0x04 || x || y
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + PUBLIC_KEY_LENGTH;
const TAG_LENGTH = 16;
/**
 * Push services only promise to accept 4096-byte bodies (RFC 8030 §7.2), and the header,
 * the padding delimiter and the AES-GCM tag come out of that budget.
 */
export const MAX_PLAINTEXT_BYTES = 4096 - HEADER_LENGTH - 1 - TAG_LENGTH;

/** RFC 8292 caps a VAPID JWT at 24 hours; half of that leaves room for clock skew. */
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export interface VapidKeyPair {
  /** base64url of the 65-byte uncompressed public key (the `k` parameter). */
  publicKey: string;
  /** ECDSA P-256 signing key. */
  privateKey: CryptoKey;
}

export interface Vapid extends VapidKeyPair {
  /** Contact for the push service operator: `mailto:` or `https:` URL (the JWT `sub`). */
  subject: string;
}

/** What a push needs from a stored subscription. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface SendOptions {
  /** Seconds the push service keeps the message for an offline device. */
  ttl: number;
  urgency: Urgency;
}

export type SendResult = { ok: true } | { ok: false; status: number; gone: boolean };

export interface EncryptOptions {
  /** Fixed salt (tests only); random otherwise. */
  salt?: Uint8Array;
  /** Fixed sender key pair (tests only); a fresh ephemeral pair otherwise. Its public key must be exportable. */
  localKeyPair?: CryptoKeyPair;
}

/** Decodes base64url (padding optional); also tolerates standard base64 as some clients send it. */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const trimmed = s.trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(trimmed)) throw new Error('Invalid base64url');
  const b64 = trimmed.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function assertPublicKey(bytes: Uint8Array, what: string): void {
  if (bytes.length !== PUBLIC_KEY_LENGTH || bytes[0] !== 0x04) {
    throw new Error(`${what} must be a 65-byte uncompressed P-256 point`);
  }
}

/** HKDF-SHA256 (extract + expand) as WebCrypto implements it. */
export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function ecdhSharedSecret(privateKey: CryptoKey, peerPublicRaw: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const peer = await crypto.subtle.importKey('raw', peerPublicRaw, ECDH_P256, false, []);
  // workers-types spells the ECDH `public` member `$public`; a plain object avoids its excess-property check.
  const algorithm = { name: 'ECDH', public: peer };
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
}

/** A fresh VAPID pair in the formats the Worker reads from its secrets. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  // generateKey is typed CryptoKey | CryptoKeyPair; asymmetric algorithms always yield a pair.
  const pair = (await crypto.subtle.generateKey(ECDSA_P256, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error('Exported private key has no d');
  return { publicKey: b64url(raw), privateKey: jwk.d };
}

/**
 * Imports the VAPID secrets: the public key as base64url raw (65 bytes) and the private key
 * as base64url of the 32-byte scalar (JWK `d`). WebCrypto cannot import a bare scalar, so the
 * private key goes in as a JWK whose x and y come from the public point.
 */
export async function importVapidKeys(publicB64url: string, privateB64url: string): Promise<VapidKeyPair> {
  const pub = fromB64url(publicB64url);
  assertPublicKey(pub, 'VAPID_PUBLIC_KEY');
  const d = fromB64url(privateB64url);
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be the base64url of a 32-byte P-256 scalar');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pub.subarray(1, 33)),
    y: b64url(pub.subarray(33, 65)),
    d: b64url(d),
    ext: false,
  };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, ECDSA_P256, false, ['sign']);
  return { publicKey: b64url(pub), privateKey };
}

/** VAPID keys from the Worker's secrets, or null when push is not configured. Throws on malformed keys. */
export async function vapidFromEnv(env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>): Promise<Vapid | null> {
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  // Some push services (Apple's) reject a JWT without `sub`, so a missing subject means "not configured".
  if (!pub || !priv || !subject) return null;
  return { ...(await importVapidKeys(pub, priv)), subject };
}

/**
 * The `Authorization` header value for a push to `endpoint`:
 * `vapid t=<ES256 JWT>, k=<public key>`. `now` is in milliseconds.
 */
export async function vapidAuthorization(endpoint: string, vapid: Vapid, now: number = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_JWT_LIFETIME_SECONDS, sub: vapid.subject })),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are already the raw r || s (64 bytes) that JWS ES256 wants, not DER.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(signingInput));
  return `vapid t=${signingInput}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Authorization headers by push service origin. The token names nothing but the origin and lasts
 * 12 hours, so one signature serves every device behind a push service for a whole send or cron
 * run. A cache belongs to one Vapid and one run: never keep it longer.
 */
export type VapidCache = Map<string, Promise<string>>;

/** vapidAuthorization, signed once per origin and cache. */
export function cachedVapidAuthorization(endpoint: string, vapid: Vapid, cache: VapidCache): Promise<string> {
  const origin = new URL(endpoint).origin;
  let header = cache.get(origin);
  if (!header) {
    header = vapidAuthorization(endpoint, vapid);
    cache.set(origin, header);
  }
  return header;
}

/**
 * RFC 8291 encryption of `plaintext` for a subscription (`p256dh` and `auth` as the browser
 * reports them, base64url). Returns the aes128gcm body:
 * salt(16) || rs(4) || idlen(1) || sender public key(65) || ciphertext.
 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error(`Push payload too large (${plaintext.length} > ${MAX_PLAINTEXT_BYTES} bytes)`);
  const uaPublic = fromB64url(p256dh);
  assertPublicKey(uaPublic, 'p256dh');
  const authSecret = fromB64url(auth);
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  if (salt.length !== SALT_LENGTH) throw new Error('salt must be 16 bytes');

  const local = opts.localKeyPair ?? ((await crypto.subtle.generateKey(ECDH_P256, false, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  assertPublicKey(asPublic, 'sender public key');

  const ecdhSecret = await ecdhSharedSecret(local.privateKey, uaPublic);
  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // 0x02 marks the last (here: only) record; no padding after it.
  const record = concatBytes(plaintext, new Uint8Array([0x02]));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 }, key, record));

  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_LENGTH, RECORD_SIZE);
  header[SALT_LENGTH + 4] = PUBLIC_KEY_LENGTH;
  header.set(asPublic, SALT_LENGTH + 5);
  return concatBytes(header, ciphertext);
}

/**
 * Encrypts and POSTs one message. HTTP outcomes come back as a result (404/410 mean the
 * subscription is gone for good); malformed subscription keys and network errors throw.
 * Pass a `cache` shared by the other sends of the same run to sign once per push service.
 */
export async function sendWebPush(
  sub: PushTarget,
  payload: PushPayload | string | Uint8Array,
  vapid: Vapid,
  opts: SendOptions,
  cache: VapidCache = new Map(),
): Promise<SendResult> {
  const plaintext = payload instanceof Uint8Array ? payload : enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const body = await encryptPayload(plaintext, sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(Math.max(0, Math.floor(opts.ttl))),
      Urgency: opts.urgency,
      Authorization: await cachedVapidAuthorization(sub.endpoint, vapid, cache),
    },
    body,
  });
  if (res.ok) {
    await res.body?.cancel();
    return { ok: true };
  }
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  // The endpoint is a capability URL, so only its origin goes to the logs.
  console.warn(`Push service ${new URL(sub.endpoint).origin} answered ${res.status}${detail ? `: ${detail}` : ''}`);
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410 };
}
