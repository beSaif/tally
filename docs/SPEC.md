# Tally — implementation spec (v1)

This document is the single source of truth for building Tally. It turns the
design page (`design/index.html`, also hosted at https://tally-design.pages.dev)
plus the owner's decisions into exact, buildable requirements. When something is
not covered here, follow the design page's spirit: Swiss, softened; white
background; thin rules; mono numbers; orange only for something *live*
(recording, AI-filled, top category).

## 0. Decisions (locked)

| Question | Decision |
| --- | --- |
| Layout | **A — Ledger** (home list + composer, voice → confirm sheet, overview with category bars) |
| Icon | **I2 — Receipt** (white receipt, torn edge, on black; orange bar is the total) |
| Name | **Tally** |
| Users | **Multi-user.** Anyone can sign up (optionally gated by an invite code). Email + password auth built into the Worker. |
| Extras | **Batch parsing** (C.2: one sentence → several entries), **Ask your data** (C.3: natural-language question over your entries), **French UI** (EN + FR, "Auto" follows the device) |
| Push | **Push notifications, first-class**: daily reminder, budget alerts, weekly summary, monthly report, test notification, actions, per-device management |
| Hosting | Cloudflare Workers (static assets + API) + D1, on a `workers.dev` subdomain |
| Gemini | `gemini-2.5-flash` by default (model string editable in settings). Called **from the browser** with the user's own Google AI Studio key. The key is stored in `localStorage` on the device only and is never sent to our Worker. |

## 1. Repository layout, toolchain, commands

```
tally/
  design/                 the design page (do not modify)
  docs/SPEC.md            this file
  migrations/             D1 SQL migrations (0001_init.sql ...)
  public/                 static files copied as-is: manifest.webmanifest, icons/, fonts/
  scripts/                icons.mjs (pixel icon → PNG/SVG), vapid.mjs (VAPID keys → .dev.vars), setup-cloudflare.mjs
  src/shared/             code shared by Worker and app: api.ts (API contract types), money.ts, dates.ts, constants.ts, schemas.ts (zod)
  src/worker/             the Cloudflare Worker (Hono)
    index.ts              app + router mounting + `scheduled` export  (owned by scaffold; agents add route mounts only if told)
    env.ts                Env type (bindings, vars, secrets)
    lib/http.ts           ApiError, error → JSON mapping, helpers
    lib/auth.ts           password hashing, sessions, cookie, `requireUser` middleware
    lib/db.ts             tiny helpers (uuid, nowMs, row mappers)
    routes/*.ts           one Hono sub-app per resource (auth, settings, categories, entries, summary, export, push)
    push/webpush.ts       RFC 8291 / RFC 8292 Web Push (WebCrypto only)
    push/notify.ts        compose + send notifications, dedup log, budget alerts hook
    push/scheduled.ts     cron handler (every 15 minutes)
    push/strings.ts       EN/FR notification texts
  src/app/                the PWA (Preact + TypeScript + Vite)
    main.tsx, app.tsx     bootstrap, router, auth gate
    sw.ts                 service worker (precache via Workbox injectManifest + push handlers)
    styles/tokens.css     design tokens + base + component classes (ported from the design page)
    i18n/                 en.ts, fr.ts, index.ts (t(), useLang)
    lib/api.ts            typed fetch client for /api
    lib/gemini.ts         Gemini client (text / audio / image → entries; ask-your-data; key check)
    lib/audio.ts          MediaRecorder + WAV re-encoding (16 kHz mono 16-bit)
    lib/image.ts          receipt photo downscale → JPEG
    lib/push.ts           permission + PushManager subscribe/unsubscribe + server sync
    lib/store.ts          app state (@preact/signals)
    screens/              Login, Signup, Setup, Home, Overview, Settings
    components/           Topline, Wordmark, Hero, EntryList, Composer, CaptureSheet, ConfirmSheet, EntrySheet, CategoryBars, AskBox, Icons, ...
  tests/unit/             Vitest (node env): shared helpers, gemini request/response, audio encoder, i18n parity
  tests/worker/           Vitest with @cloudflare/vitest-pool-workers: API + auth + push + scheduled
  e2e/                    Playwright: full flows with mocked Gemini and fake PushManager
  index.html              Vite entry (links manifest, icons, fonts)
  vite.config.ts, wrangler.jsonc, tsconfig*.json, vitest.unit.config.ts, vitest.worker.config.ts, playwright.config.ts
```

Toolchain (pinned majors): TypeScript 5.9, Vite 7, Preact 10 (+ `@preact/signals`), Hono 4, zod 4,
wrangler 4, Vitest 4 + `@cloudflare/vitest-pool-workers` 0.22, `@playwright/test` 1.56 (matches the
sandbox's Chromium 1194), `vite-plugin-pwa` 2 (strategy `injectManifest`), `geist` (self-hosted fonts).

Commands (`package.json`):

| Script | What |
| --- | --- |
| `npm run dev` | Vite dev server on :5173 (proxies `/api` → :8787) + `wrangler dev --port 8787 --test-scheduled` |
| `npm run build` | `vite build` → `dist/` (assets served by the Worker) |
| `npm run preview` | build, then `wrangler dev` serving the built app on :8787 |
| `npm run check` | typecheck app + worker |
| `npm test` | unit tests then Worker tests |
| `npm run e2e` | Playwright (builds, migrates local D1, starts `wrangler dev`) |
| `npm run icons` | regenerate `public/icons/*` from the pixel grid |
| `npm run vapid` | generate VAPID keys into `.dev.vars` (if missing) |
| `npm run db:migrate:local` / `db:migrate:remote` | apply D1 migrations |
| `npm run deploy` | build + remote migrations + `wrangler deploy` |

Conventions: ESM everywhere, strict TypeScript, no `any` without a comment, named exports, small
pure functions in `src/shared` with unit tests, errors as `ApiError(code, status, message)`.
Comments explain *why*, not *what*. Keep dependencies minimal (no UI kit, no CSS framework).

## 2. Design system

### 2.1 Tokens (from the design page, verbatim)

```css
--bg:#FFFFFF; --paper:#F6F6F4; --ink:#0B0B0B; --ink2:#2A2A2A; --mute:#7A7A7A; --faint:#B5B5B5;
--line:#E7E7E4; --acc:#FF4F00; --ok:#1A7F37; --err:#C62828;
--sans:"Geist",ui-sans-serif,system-ui,sans-serif; --mono:"Geist Mono",ui-monospace,monospace;
```

Fonts: **Geist** (400–800) and **Geist Mono** (400–600), self-hosted variable woff2 from the `geist`
npm package in `public/fonts/`, declared in `tokens.css`. Numbers always use `.mono` with
`font-feature-settings:"tnum" 1`. Base font 14px / line-height 1.4. Body background is **white**
(the design page's grey `--paper` is the board behind the phones, not the app).

Radii: field 12px · composer box 14px · button 12px · icon button 10px · sheet top 22px · pill 999px · tabs 10px.
Rules: 1px `--line`; a 1px `--ink` rule separates sections that matter (topline bottom, day-group header bottom, sheet top).
Orange (`--acc`) is used **only** for: recording state, the AI pill dot, the top category bar/colour, new-entry highlight, the wordmark's dot/receipt total bar. Never for buttons (primary buttons are ink).

### 2.2 Component classes (port of the design CSS; the scaffold ships them in `src/app/styles/tokens.css`)

Use these classes rather than inventing new styling. Values are from the design page; a few are
adapted from the 340×720 phone mock to a real viewport (fixed composer and sheets, safe-area insets,
16px inputs so iOS does not zoom on focus).

- `.screen` — column flex, `min-height:100dvh`, horizontal padding 20px, `max-width:520px` centred on desktop.
- `.topline` — flex space-between, mono 11px uppercase letter-spacing .06em, padding 6px 0 10px, 1px `--line` bottom border.
- `.wordmark` — Geist 800 15px letter-spacing -.02em, 18×18 icon with 4px radius before the word.
- `.lbl` — mono 10px uppercase letter-spacing .08em `--mute`.
- `.big` — mono 500, letter-spacing -.05em, line-height .95 (hero 58px with the decimals in `--faint`; overview 46px).
- `.cur` — mono 12px `--mute` letter-spacing .02em.
- `.daygrp` — flex space-between, margin-top 18px, padding-bottom 6px, 1px `--ink` bottom; children mono 10.5px uppercase .08em.
- `.entries li` — grid `40px 1fr auto`, gap 10px, baseline, padding 11px 0, 1px `--line` bottom. `.t` mono 11px mute · `.n` 14.5px/500/-.01em · `.c` 11.5px mute block · `.a` mono 14px/500.
- `.composer` — fixed bottom, padding 12px 16px (16px + safe-area), white gradient from transparent to `#fff` at 22%.
- `.cbox` — flex, gap 8px, 1px `--ink` border, radius 14px, padding 6px 6px 6px 14px, white. Text input inside: flex 1, 16px, placeholder `--faint`.
- `.ibtn` — 40×40 radius 10px grid-centred; `.dark` ink bg white icon; `.acc` orange bg; `.ghost` ink icon transparent bg. Icons 20px, stroke 1.6–1.8.
- `.dim` — fixed inset 0, `rgba(255,255,255,.72)`.
- `.sheet` — fixed bottom, white, 1px `--ink` top, radius 22px 22px 0 0, padding 16px 20px (18px + safe-area), shadow `0 -20px 40px rgba(0,0,0,.06)`, `max-height:88dvh; overflow:auto`.
- `.wave` — flex, gap 3px, height 34px; bars 3px wide, `--acc`, radius 1px.
- `.kv` — grid `86px 1fr`, 1px `--line` top; cells padding 9px 0 with `--line` bottom; odd cells = `.lbl` style (mono 10.5px uppercase mute, padding-top 12px).
- `.btns` — grid `1fr 2fr` gap 8px margin-top 16px. `.btn` — 48px high, radius 12px, 600 15px, 1px `--ink` border; `.primary` ink bg white text; `.acc` orange (not used for actions).
- `.pill` — inline-flex mono 10.5px uppercase .06em, 1px `--line` border, radius 999, padding 4px 9px, `--ink2`; `.on` = ink bg/border, white text. `.dot` 6px orange circle.
- `.bars li` — padding 11px 0, `--line` bottom; `.top` flex space-between baseline margin-bottom 7px (`b` 500 14px, `span` mono 13px); `.track` 4px `--paper`; `.fill` 4px `--ink` (top category: `--acc`).
- `.tabs` — flex, 1px `--ink` border, radius 10px, overflow hidden, margin 14px 0 18px; cells flex 1 centred mono 11px uppercase .06em padding 8px, right border `--ink`; `.on` ink bg white.
- `.quote` — 15px `--mute` (or `--ink2`), line-height 1.45, padding-left 12px, 1px `--faint` left border.
- `.check` — 18px square radius 5px ink bg with 12px white check.
- `.field` — 1px `--ink` border radius 12px padding 10px 12px 12px; `.v` mono 14px flex space-between.
- `.step` — flex gap 4px margin 14px 0 26px; `i` flex 1 height 2px `--line`; `.on` ink.
- `.chips` — flex wrap gap 6px.
- `.hair` — 1px `--line`.

Hero number: integer part in ink, decimals in `--faint` (`1 284` + `.60`), currency as `.cur` after it.

### 2.3 Icons

Line icons (inline SVG components in `components/Icons.tsx`, from the design page):

```
mic:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>
cam:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 8h3.2l1.6-2.5h7.4L17.3 8h3.2v11h-17z"/><circle cx="12" cy="13" r="3.4"/></svg>
ok:   <svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2 5 8.5l4.5-5"/></svg>
```
Add in the same style (stroke 1.8, round caps): `send` (arrow up), `back` (chevron left), `gear`, `close` (×), `trash`, `bell`, `plus`, `chevron-down`, `stop` (square).

App icon **I2 Receipt**, 16×16 pixel grid (K = `#0B0B0B` background, W = `#FFFFFF`, O = `#FF4F00`):

```
................
...WWWWWWWWWW...
...WWWWWWWWWW...
...WKKKKKWWWW...
...WWWWWWWWWW...
...WKKKWWWKKW...
...WWWWWWWWWW...
...WKKKKWWWKW...
...WWWWWWWWWW...
...WOOOOOOOOW...
...WOOOOOOOOW...
...WWWWWWWWWW...
...WWWWWWWWWW...
...WWWWWWWWWW...
...W.W.W.W.W....
................
```
Rendered with hard edges (`shape-rendering:crispEdges`, nearest-neighbour). Files in `public/icons/`:
`icon.svg` (favicon, 16×16 viewBox), `icon-32.png`, `icon-192.png`, `icon-512.png` (edge-to-edge, the OS rounds corners),
`maskable-512.png` (the 16×16 grid centred in a 20×20 black grid so the receipt sits inside the safe zone),
`apple-touch-icon.png` (180, edge-to-edge). The in-app wordmark uses the same SVG at 18px with 4px radius.

## 3. Screens and flows

Routes (History API, SPA fallback served by the Worker): `/login`, `/signup`, `/setup`, `/` (home), `/overview`, `/settings`.
Auth gate: unauthenticated → `/login`. Authenticated but (no Gemini key on this device) or (`settings.setup_complete` false) → `/setup`.
Everything renders inside `.screen`; on desktop the column is centred (max 520px) with the composer/sheets aligned to it.
All copy is localised (§4). Strings below are English; FR equivalents live in `i18n/fr.ts`.

### 3.1 Sign up / Log in (new, same visual language as Setup)

- Topline-free. `.step`-free. Wordmark (receipt icon + "Tally") top-left with 8px top padding.
- `h1` 34px/700/-.035em/line-height 1: **"Create your account."** / **"Welcome back."**
- Paragraph 14.5px `--ink2` max 30ch: "Tally turns a sentence, a voice note or a receipt into expenses. Your Gemini key stays on your device."
- Fields: `.lbl` "Email" + `.field` (input type email, autocomplete), `.lbl` "Password" + `.field` (type password, autocomplete new-password / current-password, min 8 chars on signup, a show/hide text toggle as a `.pill`). Signup also shows `.lbl` "Invite code" + `.field` **only** when the server reports `invite_required` (after a 403) — the field appears with the error.
- Error line: 12px `--err` under the fields (`invalid_credentials` → "That email or password is not right."; `email_taken` → "There is already an account for this email."; `invite_required` → "This Tally needs an invite code."; `signups_disabled` → "Sign-ups are closed on this Tally."; `rate_limited` → "Too many attempts. Try again in a few minutes.").
- Bottom (`margin-top:auto`): `.btn.primary` "Create account" / "Log in"; under it a 14px underlined link "Already have an account? Log in" / "New here? Create an account". Button shows a busy state (text → "…", disabled) while the request runs.
- After signup → `/setup` step 1. After login → `/setup` (step 1 only if this device has no key; step 2 only if `setup_complete` is false) else `/`.

### 3.2 Setup (design 00.1, 00.2)

Step 1 — API key: `.step` (1 of 2 on) · `.lbl` "Step 01 / 02" · `h1` "Bring your own key." · paragraph "Tally uses Gemini to read what you type, say, or photograph. Paste a key from Google AI Studio. The free tier is enough." · `.lbl` "Google AI Studio API key" · `.field` with a password-style input showing the masked key (`AIza••••••••••••••Qx4` style: first 4 + bullets + last 3 once validated) and a `.pill` **Paste** button (reads `navigator.clipboard.readText()`; falls back to focusing the input) · status row (mono 11px): while checking "Checking key…" with a pulsing `.dot`; success: green dot + "Key works · gemini-2.5-flash"; failure: red dot + reason ("Key rejected by Google" / "Model not found: …" / "No network") · link "Get a key at aistudio.google.com →" (`https://aistudio.google.com/app/apikey`, new tab) · bottom: note 12px mute "Your key stays on this device and is only sent to Google." + `.btn.primary` **Continue** (enabled only after a successful check). The check runs automatically 600ms after the input changes (debounced) and on paste.

Step 2 — Defaults (skipped if `setup_complete` is already true): `.step` (both on) · "Step 02 / 02" · `h1` "A few defaults." · `.kv`: **Currency** (select: CHF, EUR, USD, GBP, JPY, CAD, AUD, INR, …; label "CHF — Swiss franc", default from `navigator.language` region: CH→CHF, else EUR/USD/GBP by region, fallback CHF) · **Language** (select: Auto (EN / FR), English, Français) · **Budget** (mono input, right side "/ month", optional; empty = no budget) · `.lbl` "Categories — tap to remove" · `.chips` with `.pill.on` per category (tap toggles off/on; off pills are plain `.pill`) and a trailing `.pill` "+ Add" (turns into an inline input; Enter adds) · bottom `.btn.primary` **Start logging** → `PUT /api/settings {…, setup_complete:true}` + `PUT /api/categories` (replace list) → `/`.

Default categories by language: EN `Groceries, Dining, Transport, Home, Health, Fun, Shopping, Bills`; FR `Courses, Restaurants, Transport, Maison, Santé, Loisirs, Shopping, Factures`.

### 3.3 Home (design A.1)

- `.topline`: left `.wordmark` (tap → `/settings`); right: a button "OCT 2026" (current month, mono uppercase; tap → `/overview`) followed by a 28px ghost gear icon (tap → `/settings`).
- Hero (padding 22px 0 18px): `.lbl` "Spent this month" · `.big` 58px total with faint decimals + `.cur` currency · row (margin-top 14px) mono 11px mute: left `"64% OF 2 000"` (only when a budget is set; `round(total/budget*100)`; budget formatted without decimals when whole), right `"26 DAYS LEFT"` (days remaining after today) · `.track`/`.fill` width = min(100, pct)% (fill turns `--acc` at ≥100%). Without budget: only the "days left" text, no bar.
- Entries, grouped by day (newest day first, newest entry first within a day): `.daygrp` label "TODAY" / "YESTERDAY" / "SUN 04" (weekday short + day) with the day total on the right; `.entries` rows: time `HH:MM`, name + category (uncategorised shows "Other"), amount. Tap a row → **Entry sheet** (§3.7). Rows added in this session get a 1.5s fading `--acc` 2px left bar.
- The list shows the current month. At the bottom a mono 11px link "SHOW SEPTEMBER →" loads the previous month under a `.daygrp`-style month header "SEPTEMBER 2026 · 1 102.30"; repeatable. Bottom padding leaves room for the composer (≈ 120px + safe-area).
- Empty month: mute 14.5px text "Nothing logged yet. Type a line or tap the mic." centred vertically in the list area.
- Pull-to-refresh is not needed; refetch on `visibilitychange` → visible and on `focus`.

### 3.4 Composer (bottom bar)

`.composer > .cbox`: text input (placeholder "Coffee 4.50 — or just talk", Enter sends, no newline) · camera `.ibtn.ghost` (opens a hidden `<input type=file accept="image/*" capture="environment">`; a chosen file → **Capture sheet** in photo mode) · right `.ibtn.dark` is **mic** when the input is empty and **send** (arrow up) when it has text.

Mic behaviour: `pointerdown` starts recording immediately (asks for microphone permission the first time). If the pointer is released within 300ms → **tap mode**: keep recording, the sheet shows "TAP TO STOP"; tapping the sheet's stop button (or the mic again) sends. Otherwise → **hold mode**: the sheet shows "RELEASE TO SEND"; releasing sends. Dragging the pointer up by more than 80px before releasing cancels (the label flips to "RELEASE TO CANCEL"). Max 60s (auto-send). Recording uses `lib/audio.ts` (§7.3).

Sending text: shows the Capture sheet in "thinking" state immediately, then the parsed result. The input clears on success and keeps the text on failure.

### 3.5 Capture sheet (design A.2; states: recording → thinking → result | error)

`.dim` + `.sheet`. Header row: left `.lbl` in `--acc`: "● LISTENING · 0:06" (live timer) · right `.lbl`: "RELEASE TO SEND" / "TAP TO STOP" / "RELEASE TO CANCEL". Below: `.wave` with 46 bars animated from the microphone (`AnalyserNode`, 60fps, bar height 4–30px). For text/photo there is no header row; the sheet opens directly in thinking state (photo mode shows a 64px rounded thumbnail of the picture).

Thinking: label "● GEMINI IS LISTENING…" / "● GEMINI IS READING…" (orange dot pulsing), the wave frozen at low amplitude in `--faint`, a 3-line skeleton (`--paper` blocks) where the result will be. Cancelable with an × in the top-right (aborts the request).

Result (single entry): `.quote` with the transcript (voice) or the typed text (text); photo shows the thumbnail instead · row: `.lbl` "Gemini parsed" + `.pill` with `.dot` "AI" · `.kv`: **Amount** (mono 20px/500 `21.00` + `.cur`), **What** (description), **Category**, **When** ("Today, 20:14" / "Yesterday, 12:40" / "Sat 03, 11:20"), **Note** (`--mute`, hidden when empty) · `.btns`: **Edit** (1fr) · **Save** (2fr, primary).

Result (several entries, design C.2): row `.lbl` "3 entries found" + `.pill` "● Gemini" · list with `.check` toggles (all on by default; tap toggles; off = `.check` outlined and row at 45% opacity) each row `amount · description · category (· note)` in `.entries`-like grid `auto auto 1fr` · row "Total" `.lbl` + mono 16px/500 `50.20 CHF` (sum of checked) · `.btns`: **Edit** · **Log 3 entries** (count = checked). Tapping a row's text (not the check) opens it in edit mode inline.

Edit mode: the `.kv` values become inputs: Amount (`inputmode="decimal"`, accepts `12.5`, `12,5`, `12`), What (text), Category (a `.chips` row of `.pill`s, one `.on`, plus "Other"), When (`datetime-local`), Note (text). **Save** persists. In batch mode, Edit expands every entry into compact editable rows.

Nothing parsed (`entries` empty): `.quote` of the input + Gemini's `reply` line (e.g. "I could not find an amount in that."), `.btns`: **Type it** (focuses the composer with the text) · **Try again**.

Error: a 14px `--err` line mapped from the Gemini error code (invalid key → "Gemini rejected your key. Check it in Settings." with a link; quota → "Gemini's free tier is out of requests for now. Try again in a minute."; network → "No connection to Gemini."; bad response → "Gemini answered something I could not read.") + `.btns` **Close** · **Try again**.

Saving: `POST /api/entries { entries:[…] }` with `source` = `voice|text|photo` and `raw_input` = transcript/text/`"photo"`. Close the sheet, scroll the list to top, highlight the new rows. On a 4xx/5xx keep the sheet open and show the error line.

### 3.6 Overview (design A.3 + C.3)

- `.topline`: left "← BACK" (button) · right "OVERVIEW".
- `.tabs`: Week · Month · Year (default Month; remembered in the URL `?p=week|month|year`).
- Period row: `.lbl` with ‹ › arrows: "‹ OCTOBER 2026 ›" (Week: "WEEK 41 · 5–11 OCT"; Year: "2026"). › is disabled beyond the current period.
- `.big` 46px total + `.cur`. Below it mono 11px mute: "12 ENTRIES · AVG 42.80 / DAY" (Week/Month) or "AVG 1 102.30 / MONTH" (Year).
- `.bars`: categories sorted by total desc; the first bar is `--acc`, the rest `--ink`; widths relative to the top category. Name on the left; when the previous period has a total for that category show a delta `+18%` in mono 11px mute after the name (design C.3). Uncategorised entries appear as "Other".
- Row: mono 11px mute link "EXPORT CSV →" — `<a href="/api/export.csv?from=…&to=…" download>`.
- **Ask your data** (design C.3): a `.cbox` with placeholder `Ask: "how much on coffee this month?"` and a `.ibtn.dark` send. The answer renders **above** the box as the C.3 paragraph: 26px/700/-.03em/line-height 1.12 with amounts wrapped in `.mono` 500 and the first category name in `--acc` (if the answer contains one). While waiting: three pulsing dots. Only the latest answer is kept. Context sent to Gemini = the entries of the visible period (§7.5). If this device has no key, the box shows "Add your Gemini key in Settings to ask questions." instead.

### 3.7 Entry sheet (edit / delete an existing entry)

Same `.sheet` as the confirm sheet, pre-filled in edit mode (Amount, What, Category, When, Note), header `.lbl` "Edit entry" + a `trash` ghost icon on the right (tap → "Delete this entry?" two-button confirm inside the sheet → `DELETE /api/entries/:id`). `.btns`: **Cancel** · **Save** → `PATCH /api/entries/:id`. Deleted entries get a 5s toast "Entry deleted · UNDO" (undo re-creates it via POST with the same fields).

### 3.8 Settings

`.topline` "← BACK" / "SETTINGS". Sections separated by `.daygrp`-style headers (mono 10.5px uppercase, ink rule). Rows use `.kv` (label left, value/control right).

1. **Gemini** — API key (masked; "Change" `.pill` opens an inline field with the same live check as setup; "Remove" clears it from this device) · Model (text input, default `gemini-2.5-flash`; the check uses it) · link "Get a key at aistudio.google.com →" · note "Your key is stored only in this browser."
2. **Defaults** — Currency, Language, Budget (same controls as setup; save on change via `PUT /api/settings`).
3. **Categories** — `.chips` of `.pill.on`; tap → inline "Remove Dining? Entries keep their history as Other." confirm; "+ Add". Replacing via `PUT /api/categories`.
4. **Notifications** (§8) — a master row "Notifications on this device" with a toggle (`.pill` ON/OFF style switch) → permission + subscribe. When the browser does not support push, show the reason ("This browser cannot receive notifications." / iOS not installed: "On iPhone, add Tally to your Home Screen first, then enable notifications." with a short how-to). When on: rows **Daily reminder** (toggle) + **Reminder time** (`<input type=time>`) + **Only if nothing was logged** (toggle) · **Budget alerts** (toggle; "At 50%, 80% and 100% of your budget") · **Weekly summary** (toggle; "Monday morning") · **Monthly report** (toggle; "First day of the month") · **Send a test notification** (`.btn`) · **Devices**: list of subscriptions (user agent summary, "this device" pill, trash to remove).
5. **Account** — Email · **Change password** (inline current/new) · **Log out** (`.btn`) · **Delete account** (`.btn` with `--err` text; confirm by typing the email) .
6. **Install** — shown when not running standalone: Android/desktop: `.btn` "Install Tally" (uses the captured `beforeinstallprompt`); iOS: the Share → "Add to Home Screen" how-to.
7. **About** — "Tally v{version}", link to the GitHub repo, "Design round 01" link to `/design/` is **not** shipped (design folder is not part of the build).

### 3.9 Global behaviours

- Amounts render as `formatAmount(cents)` → `1 284.60` (narrow no-break space U+202F thousands separator, dot decimals, always 2 decimals) regardless of UI language (Swiss convention, as in the design).
- Dates render via `Intl.DateTimeFormat` with locale `en-CH` / `fr-CH`; uppercase in labels via CSS.
- Toasts: bottom-centred above the composer, ink background, white 13px text, 4–5s, one at a time.
- Offline: the shell loads from the service worker; API calls fail with a toast "You're offline." (no queueing in v1).
- Keyboard: Enter sends in the composer; Escape closes sheets; sheets trap focus.
- Accessibility: all icon buttons have `aria-label`s; the wave is `aria-hidden`; colour is never the only signal (text labels accompany orange states).
- Multi-device: on `visibilitychange` → visible, refetch the current month and settings.

## 4. Internationalisation (EN / FR)

- `settings.language`: `'auto' | 'en' | 'fr'`. Resolved language: if `auto`, `fr` when any of `navigator.languages` starts with `fr`, else `en`.
- `src/app/i18n/en.ts` and `fr.ts` export the same `Dict` type (compile-time parity; a unit test also asserts key parity). `t('key', {params})` with `{count}` plural variants via keys `key_one` / `key_other`.
- The resolved language and the device time zone are sent with push subscriptions so the Worker can localise notifications per device (§8).
- Gemini prompts tell the model the user's language; descriptions are kept in the language the user spoke/wrote.
- French typography: a narrow no-break space before `:`, `?`, `!`, `%` in UI strings (e.g. `80 % du budget`).

## 5. Data model (D1 / SQLite) — `migrations/0001_init.sql`

Timestamps `*_at` are **Unix milliseconds** (INTEGER). `occurred_at` is the user's **local wall-clock time**
as `YYYY-MM-DDTHH:MM` (TEXT, minute precision, no offset) because expenses are grouped by the user's day.
Amounts are **integer minor units** (`amount_cents`) with a 3-letter `currency`. IDs are `crypto.randomUUID()`.

```sql
users(id PK, email UNIQUE NOT NULL (lower-cased), password_hash NOT NULL, created_at)
sessions(id PK = sha256(token) hex, user_id FK→users ON DELETE CASCADE, created_at, expires_at, user_agent)
settings(user_id PK FK→users CASCADE, currency 'CHF', language 'auto', budget_cents NULL, model 'gemini-2.5-flash',
         setup_complete 0, notif_reminder 0, notif_reminder_time '20:30', notif_reminder_only_if_empty 1,
         notif_budget 1, notif_weekly 1, notif_monthly 1, created_at, updated_at)
categories(id PK, user_id FK CASCADE, name NOT NULL, position INT 0, created_at, UNIQUE(user_id, name COLLATE NOCASE))
entries(id PK, user_id FK CASCADE, amount_cents INT ≥ 0, currency, description NOT NULL, category_id FK→categories ON DELETE SET NULL,
        occurred_at TEXT, note NULL, source 'text'|'voice'|'photo'|'manual', raw_input NULL, created_at, updated_at)
  INDEX entries(user_id, occurred_at)
login_attempts(email, ip '' (CF-Connecting-IP), attempted_at) INDEX(email, ip, attempted_at)
push_subscriptions(id PK, user_id FK CASCADE, endpoint UNIQUE, p256dh, auth, user_agent, lang 'en', tz 'UTC', created_at, last_seen_at, failures 0)
notification_log(user_id FK CASCADE, kind, period_key, sent_at, PRIMARY KEY(user_id, kind, period_key)) INDEX(sent_at)
reminder_skips(user_id FK CASCADE, day 'YYYY-MM-DD', PRIMARY KEY(user_id, day)) INDEX(day)
```

Signup creates the `users` row, a `settings` row with defaults and the default categories for the
signup language (sent by the client as `language: 'en'|'fr'` in the signup body).

## 6. API contract (Worker, Hono, all under `/api`)

Types live in `src/shared/api.ts` (authoritative). JSON in/out. Errors are
`{ "error": { "code": string, "message": string } }` with codes:
`unauthorized` 401 · `invalid_credentials` 401 · `email_taken` 409 · `invite_required` 403 · `signups_disabled` 403 ·
`validation` 400 · `not_found` 404 · `rate_limited` 429 · `forbidden` 403 · `internal` 500.

Auth: cookie `tally_session` (HttpOnly; `Secure` when the request is https; `SameSite=Lax`; `Path=/`; 30 days;
renewed when < 15 days remain, at most once a day). State-changing requests must carry `Content-Type: application/json`
(or be the CSV/empty-body endpoints listed) and, when an `Origin` header is present, it must match the
request origin (else 403). `requireUser` middleware puts `{ id, email }` on `c.var.user`.

| Method & path | Body → Response |
| --- | --- |
| `POST /auth/signup` | `{ email, password (≥8), language: 'en'\|'fr', invite_code? }` → 201 `{ user }` + cookie. Env `SIGNUPS_ENABLED="false"` → 403 `signups_disabled`. Env `INVITE_CODE` set and ≠ body → 403 `invite_required`. |
| `POST /auth/login` | `{ email, password }` → 200 `{ user }` + cookie. Generic `invalid_credentials`. 429 after ≥ 10 failures for that email from the caller's address (`CF-Connecting-IP`) in 15 min, or ≥ 100 for the email from all addresses; a successful login clears its own address's failures. |
| `POST /auth/logout` | → 204, deletes the session, clears the cookie. |
| `GET /auth/me` | → `{ user, settings, categories }` (bootstrap). 401 if no session. |
| `POST /auth/password` | `{ current, new }` → 204. Other sessions of the user are revoked. |
| `DELETE /auth/account` | `{ password }` → 204, cascades everything. |
| `GET /settings` · `PUT /settings` | `Partial<SettingsInput>` → `{ settings }`. Validates currency (3 upper letters), language, `budget_cents` (null or 0..1e9), model (1..80 chars), notification fields (`reminder_time` `HH:MM`). |
| `GET /categories` · `PUT /categories` | PUT `{ categories: Array<{ id?: string, name: string }> }` replaces the list in order: existing ids are kept/renamed/re-positioned, missing ids are deleted (entries → `category_id = NULL`), new names are created. Names trimmed, 1..40 chars, unique case-insensitively. → `{ categories }`. |
| `GET /entries?from=YYYY-MM-DD&to=YYYY-MM-DD` | inclusive day range, ≤ 366 days → `{ entries }` ordered by `occurred_at DESC, created_at DESC`. |
| `POST /entries` | `{ entries: NewEntry[] }` (1..50) → 201 `{ entries }`. `NewEntry = { amount_cents, currency?, description, category_id?: string\|null, category?: string\|null (name; resolved case-insensitively to an id, unknown → null), occurred_at, note?, source, raw_input? }`. Triggers budget alerts (§8.4). |
| `PATCH /entries/:id` | `Partial<NewEntry>` → `{ entry }`. 404 if not the user's. Triggers budget alerts. |
| `DELETE /entries/:id` | → 204. |
| `GET /summary?from&to&prev_from?&prev_to?` | → `Summary` = `{ from, to, total_cents, count, by_category: [{ category_id, name, total_cents, count, prev_total_cents? }], by_day: [{ day, total_cents, count }], previous?: { total_cents, count } }`. Categories sorted by `total_cents` desc; uncategorised as `{ category_id: null, name: null }`. |
| `GET /export.csv?from&to` | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="tally-<from>_<to>.csv"`. Header `date,time,amount,currency,description,category,note,source,id`; RFC 4180 quoting; amount as `12.50`; UTF-8 BOM. |
| `GET /push/vapid-public-key` | → `{ key }` (base64url of the 65-byte uncompressed P-256 public key). |
| `GET /push/subscriptions` | → `{ subscriptions: [{ id, endpoint, user_agent, lang, tz, created_at, last_seen_at }] }`. |
| `POST /push/subscribe` | `{ subscription: { endpoint, keys: { p256dh, auth } }, user_agent?, lang, tz }` → 200 `{ id }` (upsert on endpoint; re-subscribing updates keys/lang/tz/`last_seen_at`; an account keeps at most 10 devices, the least recently seen are dropped). |
| `PATCH /push/subscriptions/:id` | `{ lang?, tz? }` → 204. |
| `DELETE /push/subscriptions/:id` | → 204. |
| `POST /push/test` | `{ endpoint?: string }` → `{ sent: number }` (that device, or all of the user's devices). |
| `POST /push/skip` | `{ day: 'YYYY-MM-DD' }` → 204 (no reminder that day). |

Validation with zod schemas from `src/shared/schemas.ts`; `validation` errors list the first issue path in `message`.
All list endpoints are scoped by `user_id`. No endpoint ever returns another user's row (404, not 403).

## 7. Gemini contract (browser-side, `src/app/lib/gemini.ts`)

### 7.1 Transport

`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with headers
`x-goog-api-key: <key>` and `Content-Type: application/json`. Default model `gemini-2.5-flash`.
Request: `{ systemInstruction: { parts:[{text}] }, contents:[{ role:'user', parts:[…] }], generationConfig:{ temperature:0.2, responseMimeType:'application/json', responseSchema, thinkingConfig:{ thinkingBudget:0 } } }`.
If the API answers 400 mentioning `thinking`/`thinkingConfig` (older or newer models), retry once without `thinkingConfig`.
Parse `candidates[0].content.parts.map(p=>p.text).join('')` as JSON (strip ```json fences if present). Validate with zod (`schemas.ts`), coerce `amount` → `amount_cents = Math.round(amount*100)`.
Errors → `GeminiError` with `code: 'invalid_key' (400 API_KEY_INVALID / 403) | 'model_not_found' (404) | 'quota' (429) | 'network' | 'bad_response' | 'unknown'`, `status`, `message`. Respect an `AbortSignal`.

### 7.2 Key check

`GET https://generativelanguage.googleapis.com/v1beta/models/{model}` with `x-goog-api-key`. 200 → `{ ok:true, model }`; 400/403 → `invalid_key`; 404 → `model_not_found`; fetch failure → `network`.

### 7.3 Inputs

- **Text**: `parts:[{text: userText}]`.
- **Voice**: `MediaRecorder` (preferred mimeType order: `audio/webm;codecs=opus`, `audio/mp4`, `audio/ogg;codecs=opus`, default). On stop, `lib/audio.ts#blobToWav16k(blob)` decodes with `AudioContext.decodeAudioData`, mixes to mono, resamples to 16 000 Hz with an `OfflineAudioContext`, and writes 16-bit PCM WAV. Send `parts:[{inlineData:{mimeType:'audio/wav', data: base64}}, {text: 'Transcribe and extract the expenses.'}]`. If decoding fails, send the original blob with its mimeType. Max 60s.
- **Photo**: `lib/image.ts#downscaleToJpeg(file, 1600, 0.85)` via canvas (respects EXIF orientation through `createImageBitmap(file, { imageOrientation:'from-image' })` when available). `parts:[{inlineData:{mimeType:'image/jpeg', data}}, {text:'This is a receipt. Extract the expense(s).'}]`.

### 7.4 System instruction (parse)

```
You turn what a person typed, said, or photographed into expense entries.
Now: {weekday} {YYYY-MM-DD} {HH:MM} ({timeZone}). Currency: {currency}. The person's language: {language}.
Categories (use exactly one of these names, or "Other"): {list}.
Rules:
- Return one entry per purchase. "groceries 23.40, coffee 4 and the train 22.80" is three entries.
- amount is the number the person pays, in {currency}, as a decimal number. Words like "forty-two" are numbers. If they say an amount was split ("we split it", "half each"), amount is their share and note states the total.
- If another currency is named, keep that currency code in "currency" and mention it in the note.
- description: short, specific, Title Case for names ("Migros lunch", "TPG ticket", "Dinner, Bains des Pâquis"); no amounts, no dates.
- occurred_at: ISO local "YYYY-MM-DDTHH:MM". Resolve "yesterday", "this morning", "Saturday". Default to now. Receipts: use the printed date/time if legible.
- category: the best match from the list; otherwise "Other".
- note: only useful extras (split, who with, half fare, items on a receipt); else null.
- confidence: 0..1 for the whole entry.
- transcript: the verbatim words for audio; the input text for text; "" for images.
- If nothing is an expense, return entries: [] and a one-sentence reply in the person's language saying what was missing.
```

Response schema (OpenAPI subset, `responseSchema`):

```json
{"type":"object","properties":{
  "transcript":{"type":"string"},
  "entries":{"type":"array","items":{"type":"object","properties":{
    "amount":{"type":"number"},"currency":{"type":"string"},"description":{"type":"string"},
    "category":{"type":"string"},"occurred_at":{"type":"string"},
    "note":{"type":"string","nullable":true},"confidence":{"type":"number"}},
    "required":["amount","currency","description","category","occurred_at","confidence"],
    "propertyOrdering":["amount","currency","description","category","occurred_at","note","confidence"]}},
  "reply":{"type":"string","nullable":true}},
 "required":["transcript","entries"],"propertyOrdering":["transcript","entries","reply"]}
```

### 7.5 Ask your data

Plain-text answer (`responseMimeType: 'text/plain'`, temperature 0.3, thinking off). System instruction:
"You answer questions about a person's expenses. Answer in {language} in one or two short sentences with
exact amounts in {currency} (format 1 284.60). Only use the data below. If the data cannot answer, say so.
Period: {label} ({from}..{to}). Total: {total}. By category: {name total, …}. Entries (date time amount category description | note):" followed by up to 400 entry lines (newest first; if more, say "…and N more" in the context). Then `contents:[{role:'user', parts:[{text: question}]}]`.

### 7.6 Module interface (frozen; the frontend builds against it)

```ts
export type GeminiConfig = { apiKey: string; model: string };
export type Lang = 'en' | 'fr';
export type ParseContext = { now: Date; timeZone: string; currency: string; language: Lang; categories: string[] };
export type ParsedEntry = { amount_cents: number; currency: string; description: string; category: string | null; occurred_at: string; note: string | null; confidence: number };
export type ParseResult = { transcript: string; entries: ParsedEntry[]; reply: string | null };
export type ParseInput = { kind: 'text'; text: string } | { kind: 'audio'; blob: Blob } | { kind: 'image'; blob: Blob };
export type AskContext = ParseContext & { periodLabel: string; from: string; to: string; totalCents: number; byCategory: Array<{ name: string; totalCents: number }>; entries: Array<{ occurred_at: string; amount_cents: number; currency: string; description: string; category: string | null; note: string | null }> };
export type KeyCheck = { ok: true; model: string } | { ok: false; code: GeminiErrorCode; message: string };
export type GeminiErrorCode = 'invalid_key' | 'model_not_found' | 'quota' | 'network' | 'bad_response' | 'unknown' | 'aborted';
export class GeminiError extends Error { code: GeminiErrorCode; status?: number }
export function checkKey(cfg: GeminiConfig, opts?: { signal?: AbortSignal }): Promise<KeyCheck>;
export function parseExpenses(cfg: GeminiConfig, input: ParseInput, ctx: ParseContext, opts?: { signal?: AbortSignal }): Promise<ParseResult>;
export function askData(cfg: GeminiConfig, question: string, ctx: AskContext, opts?: { signal?: AbortSignal }): Promise<string>;
// lib/audio.ts
export function blobToWav16k(blob: Blob): Promise<Blob>;           // throws if undecodable
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer; // pure, unit-tested
export class Recorder { start(onLevel:(levels:Float32Array)=>void): Promise<void>; stop(): Promise<Blob>; cancel(): void; readonly mimeType: string }
// lib/image.ts
export function downscaleToJpeg(file: Blob, maxSide: number, quality: number): Promise<Blob>;
```

Key storage: `localStorage['tally.gemini.key']`; model comes from server settings. Never log the key; never send it to `/api`.

## 8. Push notifications (first-class)

### 8.1 Client (`lib/push.ts`, Settings §3.8, `sw.ts`)

- Support check: `'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window`. iOS Safari supports Web Push only when installed to the Home Screen (`navigator.standalone`), so when not supported on iOS show the install how-to.
- Enable: `Notification.requestPermission()` → `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` with the key from `GET /api/push/vapid-public-key` (base64url → Uint8Array) → `POST /api/push/subscribe` with `{ subscription: sub.toJSON(), user_agent: navigator.userAgent, lang, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }`.
- On every app start when permission is `granted`: read `pushManager.getSubscription()`; if present, re-`POST /subscribe` (cheap upsert with the current lang, tz and user agent) so the server stays current and knows which device was seen last.
- Disable on this device: `sub.unsubscribe()` + `DELETE /api/push/subscriptions/:id`.
- Preferences (reminder on/off, time, only-if-empty, budget, weekly, monthly) are **account-wide** settings (`PUT /api/settings`).
- `sw.ts`: `push` → `event.waitUntil(self.registration.showNotification(payload.title, { body, tag, data:{ url, kind }, icon:'/icons/icon-192.png', badge:'/icons/badge-96.png' (monochrome receipt on transparent), actions, renotify:false, lang }))`; `notificationclick` → if `action === 'skip'` → `fetch('/api/push/skip', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ day }) })` then close; else focus an open client (`clients.matchAll({type:'window', includeUncontrolled:true})`) and `navigate(url)` or `clients.openWindow(url)`. `pushsubscriptionchange` → re-subscribe with the stored key and POST to `/api/push/subscribe`.
- Deep links: `/?compose=1` focuses the composer; `/overview?p=month` opens the month report; `/overview?p=week`.

### 8.2 Payload (JSON, encrypted end-to-end by Web Push)

```ts
type PushPayload = { kind: 'reminder'|'budget'|'weekly'|'monthly'|'test'; title: string; body: string; url: string; tag: string;
                     lang: 'en'|'fr'; day?: string /* reminder: local day for "skip" */; actions?: Array<{ action: 'log'|'skip'|'open'; title: string }> };
```

### 8.3 Server: Web Push (`push/webpush.ts`, WebCrypto only — no Node APIs)

- VAPID (RFC 8292): ES256 JWT `{ aud: origin(endpoint), exp: now+12h, sub: VAPID_SUBJECT }` signed with the P-256 private key; header `Authorization: vapid t=<jwt>, k=<publicKey base64url>`.
- Encryption (RFC 8291, `aes128gcm`): ephemeral ECDH P-256 key pair; shared secret with the subscription's `p256dh`; `IKM = HKDF(salt=auth, ikm=shared, info="WebPush: info\0" || ua_public || as_public, 32)`; `CEK = HKDF(salt16, IKM, "Content-Encoding: aes128gcm\0", 16)`; `NONCE = HKDF(salt16, IKM, "Content-Encoding: nonce\0", 12)`; record = plaintext || 0x02 (single record, padding delimiter); body = salt(16) || rs(4, 4096) || idlen(1, 65) || as_public(65) || ciphertext.
- Request: `POST endpoint` with headers `Content-Type: application/octet-stream`, `Content-Encoding: aes128gcm`, `TTL: 86400` (reminder/test: 3600), `Urgency: normal` (budget: high), `Authorization`. 201/200 → ok; 404/410 → delete the subscription; 429/5xx → `failures++` (delete after 5 consecutive); 400/401/403 → log and `failures++`.
- Functions: `generateVapidKeys()` (for the script), `sendWebPush(sub, payload, vapid, { ttl, urgency })`, plus exported primitives so tests can verify against the **RFC 8291 Appendix A test vector** (inject salt and ephemeral key).
- Secrets/vars: `VAPID_PUBLIC_KEY` (base64url raw 65 bytes), `VAPID_PRIVATE_KEY` (base64url of the 32-byte `d` scalar — i.e. JWK `d`), `VAPID_SUBJECT` (`mailto:` or https URL). Locally in `.dev.vars` via `npm run vapid`.

### 8.4 Server: what gets sent, when (`push/notify.ts`, `push/scheduled.ts`)

Cron `*/15 * * * *`. For every user with ≥1 subscription, group subscriptions by `tz`; for each tz compute the local time of the run (`Intl.DateTimeFormat` with `timeZone`) and send what is **due**, i.e. whose window is open:

| Kind | When (local) | Condition | `period_key` | Content |
| --- | --- | --- | --- | --- |
| `reminder` | from `notif_reminder_time` until 59 min after (never early; a window past midnight belongs to the day it opened on) | `notif_reminder` and no `reminder_skips` row for the day and (not `only_if_empty` or no entries that day) | `YYYY-MM-DD@<tz>` | EN "Anything spent today? One sentence is enough." · actions **Log now** (`/?compose=1`), **Skip today** |
| `weekly` | Monday 09:00–09:59 | `notif_weekly` and ≥1 entry last ISO week | `YYYY-Www@<tz>` of last week | title "Last week: 256.90 CHF" · body "Groceries led at 41% · 12 entries" (or "+8% vs the week before" when previous week > 0) · url `/overview?p=week` |
| `monthly` | 1st, 09:00–09:59 | `notif_monthly` and ≥1 entry last month | `YYYY-MM@<tz>` of last month | title "September: 1 284.60 CHF" · body "64% of your budget · Groceries 412.30 led" (no budget: "Groceries 412.30 led · 38 entries") · url `/overview?p=month` |
| `budget` | immediately after `POST/PATCH /entries` (via `ctx.waitUntil`; once per month the batch touches) | `notif_budget`, a budget is set, the entry's month is the current local month of the device tz (use the first subscription's tz), and total ≥ threshold not yet logged | `YYYY-MM:50`/`:80`/`:100` | 50 → "Halfway through your budget" · 80 → "80% of your budget" · 100 → "Budget reached"; body "1 620.00 of 2 000 CHF · 17 days left" · url `/overview?p=month` · urgency high. Only the **highest** newly-crossed threshold is sent; all crossed thresholds are logged. |
| `test` | `POST /push/test` | — | not logged | "Notifications are on" · "This is how Tally will nudge you." |

Dedup: insert into `notification_log` **before** sending (`INSERT OR IGNORE`; if no row was inserted, skip). `<tz>` in the keys is the device zone (or `UTC` when the runtime does not know it), so each zone a person has devices in gets its own copy at its own local time. If no device accepted the message but a targeted subscription remains, delete the row again so a later run in the window (or, for budget alerts, the next entry write) retries. A delivery only resets `failures`; `last_seen_at` changes only on `POST /push/subscribe`, which the client therefore repeats on every app start. Each cron run counts its D1 queries (every statement, batched or not), starts no new item past 40 and leaves the rest to the next run in the window; it also deletes `reminder_skips` older than 60 days (UTC) and `notification_log` rows older than 90 days. Localise per subscription `lang`; amounts formatted with `formatAmount`. Strings in `push/strings.ts` (EN + FR, see §4 typography).

## 9. PWA

- `public/manifest.webmanifest`: `name "Tally"`, `short_name "Tally"`, `description`, `start_url "/"`, `scope "/"`, `display "standalone"`, `background_color "#FFFFFF"`, `theme_color "#FFFFFF"`, `lang "en"`, icons (192, 512, maskable 512), `shortcuts` (Log an expense → `/?compose=1`; Overview → `/overview`).
- `index.html`: `<meta name="theme-color" content="#FFFFFF">`, `viewport-fit=cover`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style default`, `apple-mobile-web-app-title Tally`, `<link rel="apple-touch-icon">`, `<link rel="icon" href="/icons/icon.svg">`, `<link rel="manifest">`.
- Service worker via `vite-plugin-pwa` `injectManifest` from `src/app/sw.ts`: Workbox `precacheAndRoute(self.__WB_MANIFEST)`, `cleanupOutdatedCaches`, navigation route → `index.html` **except** `/api/*`; `/api/*` is never cached; `skipWaiting` on message; the app shows a toast "Update ready · RELOAD" when a new SW is waiting.
- The Worker serves `dist/` as static assets with `not_found_handling: "single-page-application"` and `run_worker_first: ["/api/*"]`.

## 10. Testing

- **Unit (node)**: `formatAmount`, `parseAmount`, period helpers (ISO week, month/year ranges, days left), CSV escaping, Gemini request builder (exact body), response parsing (fenced JSON, missing fields, zod failures → `bad_response`), WAV encoder header/bytes, i18n key parity, push payload builder.
- **Worker**: signup/login/logout/me; invite code + signups disabled; rate limit; cookie flags; origin check; settings validation; categories replace semantics (rename keeps id, delete nulls entries); entries CRUD + batch + range validation + user isolation; summary math incl. previous period + by_day; CSV content; push subscribe/upsert/list/delete/skip; webpush RFC 8291 vector + VAPID header shape; scheduled: reminder window match, only-if-empty, skip, dedup, weekly/monthly keys, budget thresholds (highest only, logged all), subscription cleanup on 410.
- **E2E (Playwright, Chromium 1194 at `/opt/pw-browsers`, viewport 390×844, DPR 2)**: Gemini mocked with `page.route('https://generativelanguage.googleapis.com/**')` returning fixtures; `PushManager.subscribe` faked via `addInitScript`. Flows: signup → setup (key check) → text log (single) → batch (three entries) → edit one → overview totals & bars → export CSV (download) → ask → settings: notifications on, test → logout → login → data still there. Screenshots saved to `e2e/__screenshots__/` (git-ignored) for visual review against the design.

## 11. Security

- PBKDF2-SHA256, 100 000 iterations (Workers' limit), 16-byte random salt, 32-byte key; stored `pbkdf2$100000$<salt b64>$<hash b64>`; constant-time compare. Session token 32 random bytes (base64url) in the cookie, SHA-256 hex in `sessions.id`.
- Generic login errors; login throttling via `login_attempts`; sign-up gated by `INVITE_CODE`/`SIGNUPS_ENABLED`.
- Same-origin check for mutating requests; `SameSite=Lax`; JSON content-type required; CSV via GET with cookie only.
- Headers on HTML responses are set by Cloudflare assets; the API adds `Cache-Control: no-store`.
- The Gemini key never reaches the Worker. Push payloads are end-to-end encrypted. No analytics, no third-party scripts, fonts self-hosted.
- Known v1 limitations (documented in README): no email verification, no password reset (no email provider), no offline queueing.

## 12. Deployment

- `wrangler.jsonc`: name `tally`, `main src/worker/index.ts`, assets `dist/`, D1 binding `DB` (`database_name: tally`, `database_id` placeholder patched by `scripts/setup-cloudflare.mjs`), `triggers.crons ["*/15 * * * *"]`, `vars.SIGNUPS_ENABLED "true"`, observability on.
- Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, optional `INVITE_CODE` (`wrangler secret put`).
- GitHub Actions: `ci.yml` (check, unit + worker tests, build, e2e) on push/PR; `deploy.yml` on push to `main` when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets exist: install → build → `wrangler d1 migrations apply tally --remote` → `wrangler deploy`.
- README: one-time setup (`npm i`, `npm run vapid`, `npm run setup:cloudflare`, secrets), local dev, tests, deploy, limitations.

## 13. Implementation notes and deviations (as built)

Recorded after the build so the spec stays honest. Each item is deliberate.

- **Voice result header** (§3.5): after Gemini answers, the sheet keeps the A.2 header and wave but reads "VOICE NOTE · 0:06" with a × and a grey wave, because orange marks only a live recording. Text results carry a "You wrote" label and photo results a "Receipt photo" label (C.2 style).
- **Tap mode** (§3.4): the sheet covers the composer (as in A.2), so "tap the mic again" is not reachable; a "■ Stop & send" button in the sheet does it. A "↑ Slide up to cancel" hint shows in hold mode.
- **Deltas** (§3.6): a 0% delta is shown whenever the previous period had a total for that category.
- **Inputs** are 16px where the design draws 14px, so iOS does not zoom on focus; with the viewport locked (§9 / native feel) this is belt and braces.
- **Notification click**: an open Tally window is routed in-app through a message instead of `client.navigate` (no reload). Notification URLs are limited to the app's own paths.
- **App, not web page**: the viewport is locked (`maximum-scale=1`, `user-scalable=no`, `interactive-widget=resizes-content`), pinch/double-tap zoom are also blocked by script for iOS Safari, overscroll bounce and pull-to-refresh are off, UI chrome is not selectable (quotes, answers and fields are), long-press callouts are off, phone/date/address auto-detection is off, and the composer/sheets follow the on-screen keyboard through `--kb` from the visual viewport (`src/app/lib/native-feel.ts`, `styles/native.css`).
- **Push subscribe** (§8.1): the client re-posts the subscription on every app start (and on a language change), since `last_seen_at` only moves on that call and picks the zone for budget alerts.
- **Scheduler** (§8.4): dedup keys carry the device zone, kinds are due for the hour after their time, each run has a D1 query budget of 40, claims are released when no device accepted a message, and old `reminder_skips`/`notification_log` rows are pruned. Budget alerts are queued once per month a batch touches. Accounts keep at most 10 devices.
- **Login throttling** (§11): per email **and** address (10 in 15 min) with a global per-email cap (100).
- **`parseAmount`**: a single separator followed by exactly three digits is a thousands separator (`1,000` → 1 000.00); `0,500` stays 0.50.
- **CSV export**: user-written columns are prefixed with an apostrophe when they start with `=`, `+`, `-`, `@`, tab or CR so spreadsheets never run them as formulas.
- **Not shipped** (documented in the README): email verification, password reset, offline queueing.
