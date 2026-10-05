/**
 * A stand-in push service: a local HTTP server the fake subscriptions point at. It accepts what
 * the Worker sends (201, like a real push service) and can decrypt it (RFC 8291 aes128gcm) with
 * the private key the fake PushManager kept, so a test can read the notification the Worker built.
 */
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PushPayload } from '../../src/shared/api';
import type { FakePushState } from './fake-push';

export interface Delivery {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** Decrypts one aes128gcm record for the subscription the fake PushManager created. */
export function decryptDelivery(body: Buffer, sub: NonNullable<FakePushState['sub']>): PushPayload {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(sub.privateJwk.d ?? ''));
  const shared = ecdh.computeSecret(senderPublic);
  const uaPublic = fromB64url(sub.p256dh);
  const ikm = hkdf(fromB64url(sub.auth), shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Padding: the plaintext ends at the last 0x02 delimiter (a single, final record).
  const end = record.lastIndexOf(2);
  return JSON.parse(record.subarray(0, end).toString('utf8')) as PushPayload;
}

export class PushSink {
  readonly deliveries: Delivery[] = [];
  private server: Server | null = null;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.deliveries.push({ path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Base URL for fake subscription endpoints (the fake appends a UUID). */
  get endpointBase(): string {
    return `http://127.0.0.1:${this.port}/push/`;
  }

  /** Deliveries for one endpoint. */
  to(endpoint: string): Delivery[] {
    const path = new URL(endpoint).pathname;
    return this.deliveries.filter((d) => d.path === path);
  }
}
