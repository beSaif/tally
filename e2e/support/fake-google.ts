/**
 * A stand-in for Google's sign-in, so the end-to-end tests never leave the machine: an authorize
 * endpoint that sends the browser straight back with a code (no account chooser), and a token
 * endpoint that answers that code with an ID token for whoever `nextUser` names. wrangler dev is
 * pointed at it through GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL (playwright.config.ts). It checks what a
 * real token endpoint would: the client id, the redirect URI and the PKCE verifier.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const FAKE_GOOGLE_PORT = Number(process.env.E2E_GOOGLE_PORT ?? 8790);
export const FAKE_GOOGLE_CLIENT_ID = 'tally-e2e';

export interface GoogleUser {
  sub: string;
  email: string;
}

interface Pending {
  nonce: string;
  challenge: string;
  redirectUri: string;
  user: GoogleUser;
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

export class FakeGoogle {
  /** Who the next sign-in is for. */
  nextUser: GoogleUser = { sub: 'nobody', email: 'nobody@example.com' };
  /** Make the next authorize call come back as a refusal, as when the person backs out at Google. */
  cancelNext = false;
  readonly tokenRequests: URLSearchParams[] = [];
  private readonly codes = new Map<string, Pending>();
  private server: Server | null = null;

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    // Keep the test worker free to exit; and wait for a previous worker's instance to let go of the port.
    server.unref();
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(FAKE_GOOGLE_PORT, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 10) throw err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${FAKE_GOOGLE_PORT}`);
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (this.cancelNext) {
        this.cancelNext = false;
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${this.codes.size + 1}-${Date.now()}`;
        this.codes.set(code, {
          nonce: url.searchParams.get('nonce') ?? '',
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri: url.searchParams.get('redirect_uri') ?? '',
          user: this.nextUser,
        });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const sent = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        this.tokenRequests.push(sent);
        const code = sent.get('code') ?? '';
        const pending = this.codes.get(code);
        this.codes.delete(code); // a code is good once
        const challenge = b64url(createHash('sha256').update(sent.get('code_verifier') ?? '').digest());
        const ok =
          pending &&
          sent.get('grant_type') === 'authorization_code' &&
          sent.get('client_id') === FAKE_GOOGLE_CLIENT_ID &&
          sent.get('redirect_uri') === pending.redirectUri &&
          challenge === pending.challenge;
        if (!ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: 'https://accounts.google.com', aud: FAKE_GOOGLE_CLIENT_ID, sub: pending.user.sub, email: pending.user.email, email_verified: true, nonce: pending.nonce, iat: now, exp: now + 3600 };
        const idToken = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'fake', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('not-a-signature')}`;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'fake', token_type: 'Bearer', expires_in: 3600, id_token: idToken }));
      });
      return;
    }
    res.writeHead(404).end();
  }
}

let shared: Promise<FakeGoogle> | null = null;

/** One stand-in per test worker, started on first use. */
export function fakeGoogle(): Promise<FakeGoogle> {
  shared ??= (async () => {
    const google = new FakeGoogle();
    await google.start();
    return google;
  })();
  return shared;
}
