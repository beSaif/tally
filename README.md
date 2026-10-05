# Tally

Minimal, AI-assisted expense tracker. Web app / PWA on Cloudflare.

Log an expense by typing, speaking, or snapping a receipt; Gemini (your own Google AI Studio key) turns it into structured entries.

## Status

**Design phase.** See [`design/index.html`](design/index.html), round 01: three layout directions, setup flow, pixel app icons, proposed stack. Implementation starts after the design is signed off.

## Proposed stack

- **Cloudflare Workers**: static PWA + JSON API
- **Cloudflare D1**: SQLite database (free tier)
- **Gemini 2.5 Flash**: called from the browser with the user's own key (key never touches the server)
- **Cloudflare Access**: single-user auth
