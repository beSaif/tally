import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { b64url } from '../../src/worker/lib/auth';
import {
  MAX_PLAINTEXT_BYTES,
  cachedVapidAuthorization,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  importVapidKeys,
  sendWebPush,
  vapidAuthorization,
  vapidFromEnv,
  type Vapid,
  type VapidCache,
} from '../../src/worker/push/webpush';
import { decryptPushBody, makeSubscriber, mockPushService, utf8 } from './push-helpers';

const td = new TextDecoder();
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };

async function testVapid(): Promise<Vapid> {
  return { ...(await importVapidKeys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)), subject: env.VAPID_SUBJECT };
}

/** Imports a P-256 key pair from its raw public point and JWK `d`, for ECDH. */
async function ecdhPair(publicB64url: string, d: string): Promise<CryptoKeyPair> {
  const pub = fromB64url(publicB64url);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d, ext: true };
  return {
    publicKey: await crypto.subtle.importKey('raw', pub, ECDH_P256, true, []),
    privateKey: await crypto.subtle.importKey('jwk', jwk, ECDH_P256, true, ['deriveBits']),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encryptPayload (RFC 8291, aes128gcm)', () => {
  it('produces a body the subscriber can decrypt', async () => {
    const sub = await makeSubscriber('https://push.example/sub/round-trip');
    const plaintext = utf8(JSON.stringify({ kind: 'test', title: 'Grüezi', body: '1 284.60 CHF · 80 % du budget' }));
    const body = await encryptPayload(plaintext, sub.p256dh, sub.auth);

    // salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext (record + 0x02 + 16-byte tag)
    expect(body.length).toBe(16 + 4 + 1 + 65 + plaintext.length + 1 + 16);
    const decrypted = await decryptPushBody(body, sub);
    expect(decrypted.recordSize).toBe(4096);
    expect(decrypted.keyIdLength).toBe(65);
    expect(decrypted.delimiter).toBe(0x02);
    expect(decrypted.plaintext).toEqual(plaintext);
  });

  it('uses a fresh salt and sender key for every message', async () => {
    const sub = await makeSubscriber('https://push.example/sub/fresh');
    const a = await encryptPayload(utf8('same'), sub.p256dh, sub.auth);
    const b = await encryptPayload(utf8('same'), sub.p256dh, sub.auth);
    expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16)));
    expect(b64url(a.slice(21, 86))).not.toBe(b64url(b.slice(21, 86)));
    expect(td.decode((await decryptPushBody(b, sub)).plaintext)).toBe('same');
  });

  it('reproduces the RFC 8291 Appendix A test vector', async () => {
    // RFC 8291, Appendix A ("When I grow up, I want to be a watermelon").
    const V = {
      plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
      asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      message:
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    };
    const body = await encryptPayload(fromB64url(V.plaintext), V.uaPublic, V.auth, {
      salt: fromB64url(V.salt),
      localKeyPair: await ecdhPair(V.asPublic, V.asPrivate),
    });
    expect(b64url(body)).toBe(V.message);

    // And the vector decrypts with the user agent's key, which also validates the test decryptor.
    const ua = await ecdhPair(V.uaPublic, V.uaPrivate);
    const decrypted = await decryptPushBody(fromB64url(V.message), { privateKey: ua.privateKey, publicRaw: fromB64url(V.uaPublic), authBytes: fromB64url(V.auth) });
    expect(td.decode(decrypted.plaintext)).toBe('When I grow up, I want to be a watermelon');
    expect(decrypted.delimiter).toBe(0x02);
  });

  it('rejects malformed subscription keys and oversized payloads', async () => {
    const sub = await makeSubscriber('https://push.example/sub/bad');
    await expect(encryptPayload(utf8('x'), b64url(new Uint8Array(33)), sub.auth)).rejects.toThrow(/p256dh/);
    await expect(encryptPayload(utf8('x'), sub.p256dh, b64url(new Uint8Array(8)))).rejects.toThrow(/auth/);
    await expect(encryptPayload(utf8('x'), 'not base64!', sub.auth)).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), sub.p256dh, sub.auth)).rejects.toThrow(/too large/);
    const max = await encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES), sub.p256dh, sub.auth);
    expect(max.length).toBe(4096);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('builds "vapid t=<ES256 JWT>, k=<public key>" with a verifiable signature', async () => {
    const vapid = await testVapid();
    const now = Date.UTC(2026, 9, 5, 18, 37, 12, 345);
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def?x=1', vapid, now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h = '', c = '', s = '', k = ''] = m ?? [];

    expect(JSON.parse(td.decode(fromB64url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(td.decode(fromB64url(c)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: 'mailto:tests@tally.test',
    });
    expect(k).toBe(env.VAPID_PUBLIC_KEY);

    const signature = fromB64url(s);
    expect(signature.length).toBe(64); // raw r || s, not DER
    const publicKey = await crypto.subtle.importKey('raw', fromB64url(env.VAPID_PUBLIC_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, utf8(`${h}.${c}`))).toBe(true);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, utf8(`${h}.${c}x`))).toBe(false);
  });

  it('uses the endpoint origin (with port) as the audience', async () => {
    const header = await vapidAuthorization('https://push.example:8443/sub/1', await testVapid(), 0);
    const claims = header.slice('vapid t='.length).split('.')[1] ?? '';
    expect(JSON.parse(td.decode(fromB64url(claims)))).toMatchObject({ aud: 'https://push.example:8443', exp: 43200 });
  });

  it('signs once per push service origin and cache', async () => {
    const vapid = await testVapid();
    // ECDSA signatures are randomised, so two signings never produce the same header.
    expect(await vapidAuthorization('https://push.example/a', vapid, 0)).not.toBe(await vapidAuthorization('https://push.example/a', vapid, 0));

    const sign = vi.spyOn(crypto.subtle, 'sign');
    const cache: VapidCache = new Map();
    const a = await cachedVapidAuthorization('https://push.example/sub/a', vapid, cache);
    const b = await cachedVapidAuthorization('https://push.example/sub/b?x=1', vapid, cache);
    const other = await cachedVapidAuthorization('https://other.example/sub/a', vapid, cache);
    expect(b).toBe(a);
    expect(other).not.toBe(a);
    expect([...cache.keys()]).toEqual(['https://push.example', 'https://other.example']);
    expect(sign).toHaveBeenCalledTimes(2);
    // A fresh cache signs again.
    expect(await cachedVapidAuthorization('https://push.example/sub/a', vapid, new Map())).not.toBe(a);
  });

  it('reads the keys from the environment, and reports missing ones as not configured', async () => {
    const vapid = await vapidFromEnv(env);
    expect(vapid?.publicKey).toBe(env.VAPID_PUBLIC_KEY);
    expect(vapid?.subject).toBe(env.VAPID_SUBJECT);
    expect(await vapidFromEnv({ VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:x@example.com' })).toBeNull();
    expect(await vapidFromEnv({ VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY })).toBeNull();
  });

  it('rejects malformed keys', async () => {
    await expect(importVapidKeys(b64url(new Uint8Array(64)), env.VAPID_PRIVATE_KEY)).rejects.toThrow(/VAPID_PUBLIC_KEY/);
    await expect(importVapidKeys(env.VAPID_PUBLIC_KEY, b64url(new Uint8Array(31)))).rejects.toThrow(/VAPID_PRIVATE_KEY/);
  });

  it('generates key pairs in the format the Worker imports', async () => {
    const keys = await generateVapidKeys();
    expect(fromB64url(keys.publicKey)).toHaveLength(65);
    expect(fromB64url(keys.privateKey)).toHaveLength(32);
    const vapid: Vapid = { ...(await importVapidKeys(keys.publicKey, keys.privateKey)), subject: 'mailto:x@example.com' };
    const header = await vapidAuthorization('https://push.example/sub/1', vapid);
    const [h = '', c = '', s = ''] = header.slice('vapid t='.length).split(', k=')[0]?.split('.') ?? [];
    const publicKey = await crypto.subtle.importKey('raw', fromB64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64url(s), utf8(`${h}.${c}`))).toBe(true);
  });
});

describe('sendWebPush', () => {
  it('POSTs the encrypted payload with the Web Push headers', async () => {
    const sub = await makeSubscriber('https://push.example/sub/send');
    const calls = mockPushService(201);
    const result = await sendWebPush(sub, { kind: 'test', title: 'T', body: 'B', url: '/', tag: 'test', lang: 'en' }, await testVapid(), { ttl: 3600, urgency: 'high' });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(sub.endpoint);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(call?.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(call?.headers.get('TTL')).toBe('3600');
    expect(call?.headers.get('Urgency')).toBe('high');
    expect(call?.headers.get('Authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const decrypted = await decryptPushBody(call?.body ?? new Uint8Array(), sub);
    expect(JSON.parse(td.decode(decrypted.plaintext))).toEqual({ kind: 'test', title: 'T', body: 'B', url: '/', tag: 'test', lang: 'en' });
  });

  it('reports gone subscriptions (404/410) apart from other failures', async () => {
    const sub = await makeSubscriber('https://push.example/sub/status');
    const vapid = await testVapid();
    const opts = { ttl: 60, urgency: 'normal' } as const;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [status, expected] of [
      [200, { ok: true }],
      [202, { ok: true }],
      [404, { ok: false, status: 404, gone: true }],
      [410, { ok: false, status: 410, gone: true }],
      [400, { ok: false, status: 400, gone: false }],
      [403, { ok: false, status: 403, gone: false }],
      [429, { ok: false, status: 429, gone: false }],
      [503, { ok: false, status: 503, gone: false }],
    ] as const) {
      mockPushService(status);
      expect(await sendWebPush(sub, 'hello', vapid, opts)).toEqual(expected);
      vi.mocked(globalThis.fetch).mockRestore();
    }
  });
});
