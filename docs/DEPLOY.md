# Deploying Tally

Everything fits in Cloudflare's free tier: one Worker serves the app and the API, D1 holds the
data, a cron trigger sends the push notifications.

1. `npm install`, then `npx wrangler login`.
2. `npm run setup:cloudflare` creates the D1 database `tally` and writes its id into
   `wrangler.jsonc`. Commit that change.
3. **Sign in with Google** (once). In the [Google Cloud console](https://console.cloud.google.com),
   create a project and configure its OAuth consent screen: external, scopes `openid` and `email`,
   home page `https://tally.<your-subdomain>.workers.dev` and privacy policy
   `https://tally.<your-subdomain>.workers.dev/privacy` (Google requires one to publish; the app
   serves it). Then create an OAuth client of type **Web application** with
   `https://tally.<your-subdomain>.workers.dev/api/auth/google/callback` among its authorized
   redirect URIs. Add the two `localhost` callbacks from the README's "Run it locally" too, and the
   custom domain's if you use one. Every address you serve the app from needs its callback listed,
   or Google refuses the sign-in.
4. **Secrets** (once):
   ```sh
   node scripts/vapid.mjs --print          # generate a production VAPID pair
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT   # e.g. mailto:you@example.com
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
5. `npm run deploy` builds, applies migrations remotely and deploys to
   `tally.<your-subdomain>.workers.dev`.

## Custom domain

The `routes` entry in `wrangler.jsonc` attaches my own domain to the Worker. **Change it to a
domain you own (the zone must be in your Cloudflare account) or remove the entry**, otherwise
the deploy fails. If you keep a custom domain, its callback must be in the OAuth client too.

## GitHub Actions

`.github/workflows/deploy.yml` deploys on every push to `main` once the repository secrets
`CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers", plus D1 edit) and
`CLOUDFLARE_ACCOUNT_ID` exist. Without them the workflow skips itself. `ci.yml` runs the
checks and tests on every push.

## Configuration

`wrangler.jsonc` vars and Worker secrets:

| Name | Kind | Meaning |
| --- | --- | --- |
| `SIGNUPS_ENABLED` | var | `"false"` closes sign-ups: only Google accounts that already have a Tally account get in (default `"true"`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secrets | the Google OAuth client (type "Web application") |
| `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL` | vars | override Google's endpoints; only the end-to-end tests do, to point at a stand-in |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | secrets | Web Push identity (`npm run vapid` locally) |

The Gemini key is never a server secret: each user pastes their own into Settings and it stays
in their browser.

## Push notifications

Users enable them in **Settings → Notifications** on each device. Android and desktop browsers
work directly; on iPhone and iPad the app has to be on the Home Screen first (Share → Add to
Home Screen), then notifications are enabled from the installed app (iOS 16.4+). Reminders
arrive at the first quarter-hour check at or after the chosen time, never early. Reminder time
and the notification kinds are account-wide; subscriptions are per device and can be removed
from the device list. The "Skip today" action on a reminder silences that day's reminder.
