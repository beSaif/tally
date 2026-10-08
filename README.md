<p align="center">
  <img src="public/icons/icon.svg" width="120" alt="Tally" />
</p>

<h1 align="center">Tally</h1>

<p align="center">Tell it what you spent. It keeps the books.</p>

I didn't want another expense app with a form. I wanted something I could just talk to: "coffee
4, groceries 23.40 at Coop, train 22.80", said out loud on the way home, and have it all land as
proper entries. That's Tally. Type it, say it, or photograph the receipt, and Gemini turns it
into structured expenses. It's bring your own key: the AI runs on your own Google AI Studio key,
straight from your browser, and nobody but you ever sees your receipts.

<p align="center">
  <img src="docs/screenshots/home.png" width="190" alt="Home: month total, budget bar, entries by day" />
  <img src="docs/screenshots/voice-confirm.png" width="190" alt="A voice note parsed into an entry to confirm" />
  <img src="docs/screenshots/batch.png" width="190" alt="One sentence parsed into three entries" />
  <img src="docs/screenshots/overview.png" width="190" alt="Month overview with category bars" />
</p>

**Try it:** [tally.codesaif.dev](https://tally.codesaif.dev). You'll need a free
[Gemini API key](https://aistudio.google.com/app/apikey).

## What it does

- Three ways to log: type a sentence, hold the mic and talk, or snap a receipt. One sentence can
  become several entries.
- A confirm sheet shows what Gemini understood (amount, what, category, when, note) before
  anything is saved.
- Month total with budget progress and entries grouped by day, one tap away from Analytics:
  spending by category with shares and deltas against last period, a drill-down into any category
  with its last six months, and CSV export.
- A monthly report for every month (total vs budget and the month before, categories, biggest
  expenses, six-month history) that saves as a PDF; the first-of-month notification opens it.
- Ask your data in plain language: "how much on coffee this month?"
- Push notifications: a daily reminder, alerts at 50 / 80 / 100 % of budget, a Monday summary and
  a first-of-month report.
- English and French. Installable PWA that behaves like a native app.

## Run it locally

Node 22 and npm 10.

```sh
npm install
npm run vapid               # Web Push keys → .dev.vars
npm run db:migrate:local    # local D1 database
npm run dev                 # http://localhost:5173, API on :8787
```

Sign-in needs a Google OAuth client in `.dev.vars` (`.dev.vars.example` explains). Then paste a
Gemini key in Settings and start logging.

```sh
npm run check      # typecheck app + Worker
npm test           # unit tests + Worker tests in workerd with D1
npm run e2e        # Playwright, with Gemini, Google sign-in and push mocked
```

## Under the hood

A Preact PWA and a [Hono](https://hono.dev) Worker on Cloudflare with D1. Audio, text and photos
go from the device straight to Gemini; the Worker only ever stores the resulting entries. Web
Push is implemented with WebCrypto (VAPID, `aes128gcm`), and a cron trigger every 15 minutes
handles reminders and summaries.

- [docs/DEPLOY.md](docs/DEPLOY.md): your own Tally on Cloudflare's free tier.
- [docs/SPEC.md](docs/SPEC.md): the build spec.
- [design/](design/): design round 01, the three layouts this was picked from.

## Privacy

Your Gemini key lives in your browser and is sent only to Google. Tally stores your Google
account id, email and entries, nothing else. Sign-in is Google's OpenID Connect flow run by the
Worker, with no Google script on the page. Export everything as CSV any time; deleting the
account removes all of it.

## License

[MIT](LICENSE)
