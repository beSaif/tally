// One-time Cloudflare setup: creates the D1 database (if needed) and writes its id into wrangler.jsonc.
// Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

let list;
try {
  list = JSON.parse(run('npx wrangler d1 list --json'));
} catch {
  console.error('Could not list D1 databases. Run `npx wrangler login` first.');
  process.exit(1);
}
let db = list.find((d) => d.name === 'tally');
if (!db) {
  console.log('Creating D1 database "tally"…');
  run('npx wrangler d1 create tally');
  list = JSON.parse(run('npx wrangler d1 list --json'));
  db = list.find((d) => d.name === 'tally');
}
if (!db) {
  console.error('Database "tally" not found after creation.');
  process.exit(1);
}
const id = db.uuid ?? db.id;
const cfg = readFileSync('wrangler.jsonc', 'utf8');
const next = cfg.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${id}"`);
writeFileSync('wrangler.jsonc', next);
console.log(`wrangler.jsonc now points at D1 "tally" (${id}).`);
console.log('Next: npm run db:migrate:remote, then set secrets: wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT');
