# Tally

Minimal, AI-assisted expense tracker. A web app / PWA on Cloudflare.

Log an expense by typing a sentence, speaking, or snapping a receipt. Gemini, called from your
browser with **your own Google AI Studio key**, turns it into structured entries. One sentence can
become several entries ("groceries 23.40 at Coop, a coffee for 4 and the train 22.80"). Ask your
data questions in plain language ("how much on coffee this month?"). Get nudged by push
notifications: a daily reminder, budget alerts, a weekly summary and a monthly report.

Design: round 01 is in [`design/index.html`](design/index.html) (hosted at
https://tally-design.pages.dev). The app implements layout **A — Ledger** with the **I2 Receipt**
icon. The build spec lives in [`docs/SPEC.md`](docs/SPEC.md).

<p align="center">
  <img src="docs/screenshots/home.png" width="190" alt="Home: month total, budget bar, entries grouped by day, composer" />
  <img src="docs/screenshots/voice-confirm.png" width="190" alt="Voice note parsed by Gemini into an entry to confirm" />
  <img src="docs/screenshots/batch.png" width="190" alt="One sentence parsed into three entries" />
  <img src="docs/screenshots/overview.png" width="190" alt="Month overview with category bars and deltas" />
</p>

## Features

- **Ledger home**: month total with budget progress, entries grouped by day, one composer bar.
- **Three ways to log**: type, hold the mic and talk, or photograph a receipt.
- **Confirm sheet**: what Gemini parsed (amount, what, category, when, note), editable, single or batch.
- **Overview**: week / month / year, category bars with deltas against the previous period, CSV export.
- **Ask your data**: a question box answered by Gemini over the entries of the visible period.
- **Settings**: Gemini key and model, currency, language (Auto / EN / FR), budget, categories,
  notifications, account, install hints.
- **Push notifications**: daily reminder at your time (optionally only if nothing was logged),
  alerts at 50 / 80 / 100 % of the budget, Monday summary, first-of-month report, test button,
  per-device management, notification actions ("Log now", "Skip today").
- **Multi-user**: sign in with Google; sign-ups can be closed.
- **PWA that feels like an app**: installable, offline shell, no pinch or double-tap zoom, no rubber-banding or pull-to-refresh, no text selection or long-press callouts on controls, composer stays above the keyboard, self-hosted fonts, no third-party scripts or analytics.

## How it works

```
 Browser (Preact PWA)                     Cloudflare
 ┌──────────────────────────┐   HTTPS    ┌─────────────────────────────┐
 │ UI · service worker      │◄──────────►│ Worker (Hono)               │
 │ Gemini key (localStorage)│  /api/*    │  static assets + JSON API   │
 └───────────┬──────────────┘            │  Web Push sender · cron     │
             │ audio / text / photo       └──────────────┬──────────────┘
             ▼                                           ▼
   Google Gemini (your key)                       D1 (SQLite)
```

- The Gemini key never reaches the Worker: audio, text and photos go straight from the device to
  Google, and only the resulting entries are saved.
- One Worker serves the built app from `dist/` and the API under `/api/*`. Data lives in D1.
- Web Push is implemented with WebCrypto (VAPID + `aes128gcm`); a cron trigger runs every 15 minutes
  for reminders and summaries, budget alerts fire right when an entry crosses a threshold.

## Local development

Prerequisites: Node 22, npm 10.

```sh
npm install                 # also generates worker-configuration.d.ts
npm run vapid               # writes VAPID keys for Web Push into .dev.vars
npm run db:migrate:local    # creates the local D1 database
npm run dev                 # Vite on http://localhost:5173 (+ wrangler on :8787 for /api)
```

Or run the built app the way production serves it:

```sh
npm run preview             # build, migrate, then wrangler dev on http://127.0.0.1:8787
```

Signing in needs a Google OAuth client (step 3 of "Deploying" below, once): put its id and secret in
`.dev.vars` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with
`http://localhost:5173/api/auth/google/callback` and `http://localhost:8787/api/auth/google/callback`
among the client's redirect URIs. Then sign in with Google, paste a Gemini key from
https://aistudio.google.com/app/apikey (the free tier is enough), pick your defaults, and start logging.

Useful scripts:

| Script | What it does |
| --- | --- |
| `npm run check` | Typecheck the app and the Worker |
| `npm test` | Unit tests (node) + Worker tests (inside workerd with D1) |
| `npm run e2e` | Playwright end-to-end tests: builds, migrates the local D1, starts `wrangler dev` on :8787 (creating `.dev.vars` if needed) and drives the real app with only Gemini, Google's sign-in (a stand-in on :8790) and the browser push API mocked. Stop any `wrangler dev` already on :8787 first, or Playwright reuses it without the sign-in stand-in. |
| `npm run icons` | Re-render the pixel icon to `public/icons/` |
| `npm run types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |

## Deploying to Cloudflare

Everything fits in Cloudflare's free tier (Workers, D1, cron triggers).

1. `npx wrangler login`
2. `npm run setup:cloudflare` — creates the D1 database `tally` and writes its id into `wrangler.jsonc` (commit that change).
3. Sign in with Google (once): in the [Google Cloud console](https://console.cloud.google.com), create a
   project and configure its OAuth consent screen (external; scopes `openid` and `email`; home page
   `https://tally.<your-subdomain>.workers.dev` and privacy policy `https://tally.<your-subdomain>.workers.dev/privacy`,
   which Google requires to publish). Then create an OAuth client of type **Web application** with
   `https://tally.<your-subdomain>.workers.dev/api/auth/google/callback` among its authorized redirect
   URIs (add the two `localhost` ones from "Local development" too, and the custom domain's if you use one).
4. Secrets (once):
   ```sh
   node scripts/vapid.mjs --print          # generate a production VAPID pair
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT   # e.g. mailto:you@example.com
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
5. `npm run deploy` — builds, applies migrations remotely, deploys to `tally.<your-subdomain>.workers.dev`.
   `routes` in `wrangler.jsonc` also attaches the custom domain `tally.codesaif.dev` (a zone in the same
   Cloudflare account); change or remove that entry for your own deployment. The callback of every
   address you serve the app from must be among the OAuth client's redirect URIs.

**GitHub Actions**: `.github/workflows/deploy.yml` deploys on every push to `main` once the
repository secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers", plus D1 edit) and
`CLOUDFLARE_ACCOUNT_ID` exist. Without them the workflow skips itself.

Configuration (`wrangler.jsonc` vars / secrets):

| Name | Kind | Meaning |
| --- | --- | --- |
| `SIGNUPS_ENABLED` | var | `"false"` closes sign-ups: only Google accounts that already have a Tally account get in (default `"true"`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secrets | the Google OAuth client (type "Web application") |
| `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL` | vars | override Google's endpoints; only the end-to-end tests do, to point at a stand-in |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | secrets | Web Push identity (`npm run vapid` locally) |

## Push notifications

Enable them in **Settings → Notifications** on each device. Android and desktop browsers work
directly; on iPhone/iPad, add Tally to the Home Screen first (Share → Add to Home Screen), then
enable notifications from the installed app (iOS 16.4+). Reminders arrive at the first quarter-hour check at or after your time (never early). Reminder time and the notification kinds
are account-wide; subscriptions are per device and can be removed from the device list. The
"Skip today" action on a reminder silences that day's reminder.

## Privacy and security

- Your Gemini key is stored only in your browser (`localStorage`) and sent only to Google.
- Sign-in is delegated to Google (OpenID Connect, authorization-code flow with PKCE and a state
  cookie, run by the Worker: no Google script on the page). Tally stores your Google account id and
  email, nothing else. Sessions are opaque tokens stored hashed, in an `HttpOnly` `SameSite=Lax`
  cookie. Cross-origin mutations are refused.
- The privacy policy is at `/privacy` (also linked from the Google consent screen).
- Push payloads are end-to-end encrypted (RFC 8291). The Worker only stores the subscription.
- Export your data any time as CSV. Deleting the account removes everything.

Known limitation of this version: no offline queueing of entries (the shell works offline, logging
needs a connection).

## Project layout

```
design/          design round 01 (reference only, not part of the build)
docs/SPEC.md     implementation spec
migrations/      D1 SQL migrations
public/          manifest, icons, fonts
scripts/         icons.mjs · vapid.mjs · setup-cloudflare.mjs
src/shared/      API contract types, money/date helpers, zod schemas
src/worker/      Cloudflare Worker: Google sign-in, sessions, routes, push (Web Push, cron)
src/app/         Preact PWA: screens, components, i18n, Gemini client, service worker
tests/           unit (node) and Worker (workerd) tests
e2e/             Playwright end-to-end tests
```
