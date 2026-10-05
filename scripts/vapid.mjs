// Generates a VAPID (P-256) key pair and writes it to .dev.vars when the values are missing.
// Usage: node scripts/vapid.mjs [--print]
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const subtle = webcrypto.subtle;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = b64url(await subtle.exportKey('raw', pair.publicKey)); // 65 bytes, uncompressed
const jwk = await subtle.exportKey('jwk', pair.privateKey);
const priv = jwk.d; // base64url of the 32-byte scalar

if (process.argv.includes('--print')) {
  console.log(`VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${priv}\nVAPID_SUBJECT=mailto:you@example.com`);
  process.exit(0);
}

const file = '.dev.vars';
let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const has = (k) => new RegExp(`^${k}=.+$`, 'm').test(text);
const set = (k, v) => {
  if (new RegExp(`^${k}=.*$`, 'm').test(text)) text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
  else text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${k}=${v}\n`;
};
if (has('VAPID_PUBLIC_KEY') && has('VAPID_PRIVATE_KEY')) {
  console.log('.dev.vars already has VAPID keys; nothing changed. Use --print to generate a fresh pair.');
  process.exit(0);
}
set('VAPID_PUBLIC_KEY', pub);
set('VAPID_PRIVATE_KEY', priv);
if (!has('VAPID_SUBJECT')) set('VAPID_SUBJECT', 'mailto:you@example.com');
writeFileSync(file, text);
console.log(`Wrote VAPID keys to ${file}. Public key: ${pub}`);
