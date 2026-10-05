-- Tally — initial schema. Timestamps are Unix milliseconds. Amounts are integer minor units.
-- occurred_at is the user's local wall-clock time 'YYYY-MM-DDTHH:MM' (no offset): expenses group by the user's day.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,               -- sha256(token) hex
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE settings (
  user_id                      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency                     TEXT NOT NULL DEFAULT 'CHF',
  language                     TEXT NOT NULL DEFAULT 'auto',
  budget_cents                 INTEGER,
  model                        TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
  setup_complete               INTEGER NOT NULL DEFAULT 0,
  notif_reminder               INTEGER NOT NULL DEFAULT 0,
  notif_reminder_time          TEXT NOT NULL DEFAULT '20:30',
  notif_reminder_only_if_empty INTEGER NOT NULL DEFAULT 1,
  notif_budget                 INTEGER NOT NULL DEFAULT 1,
  notif_weekly                 INTEGER NOT NULL DEFAULT 1,
  notif_monthly                INTEGER NOT NULL DEFAULT 1,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL
);

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name COLLATE NOCASE)
);

CREATE TABLE entries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency     TEXT NOT NULL,
  description  TEXT NOT NULL,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  occurred_at  TEXT NOT NULL,                -- 'YYYY-MM-DDTHH:MM' local
  note         TEXT,
  source       TEXT NOT NULL DEFAULT 'manual', -- text | voice | photo | manual
  raw_input    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX entries_user_time ON entries(user_id, occurred_at);

CREATE TABLE login_attempts (
  email        TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX login_attempts_email ON login_attempts(email, attempted_at);

CREATE TABLE push_subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  lang         TEXT NOT NULL DEFAULT 'en',
  tz           TEXT NOT NULL DEFAULT 'UTC',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_user ON push_subscriptions(user_id);

CREATE TABLE notification_log (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                  -- reminder | budget | weekly | monthly
  period_key TEXT NOT NULL,                  -- e.g. 2026-10-05, 2026-10:80, 2026-W40, 2026-09
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, period_key)
);

CREATE TABLE reminder_skips (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,                     -- 'YYYY-MM-DD' local
  PRIMARY KEY (user_id, day)
);
