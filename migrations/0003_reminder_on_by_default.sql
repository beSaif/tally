-- The daily reminder is on from the start, like budget alerts, the weekly summary and the monthly
-- report: a device that enabled notifications should hear from Tally without one more switch.
-- Accounts made before this migration move to the new default as well (their updated_at moves on,
-- so an open app picks the change up). SQLite cannot change a column default in place, so the
-- table is rebuilt; nothing references settings, and a migration runs as one transaction.
CREATE TABLE settings_new (
  user_id                      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency                     TEXT NOT NULL DEFAULT 'CHF',
  language                     TEXT NOT NULL DEFAULT 'auto',
  budget_cents                 INTEGER,
  model                        TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
  setup_complete               INTEGER NOT NULL DEFAULT 0,
  notif_reminder               INTEGER NOT NULL DEFAULT 1,
  notif_reminder_time          TEXT NOT NULL DEFAULT '20:30',
  notif_reminder_only_if_empty INTEGER NOT NULL DEFAULT 1,
  notif_budget                 INTEGER NOT NULL DEFAULT 1,
  notif_weekly                 INTEGER NOT NULL DEFAULT 1,
  notif_monthly                INTEGER NOT NULL DEFAULT 1,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL
);

INSERT INTO settings_new
  SELECT user_id, currency, language, budget_cents, model, setup_complete,
         1,
         notif_reminder_time, notif_reminder_only_if_empty, notif_budget, notif_weekly, notif_monthly,
         created_at,
         CASE WHEN notif_reminder = 0 THEN MAX(updated_at + 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000) ELSE updated_at END
    FROM settings;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;
