-- Recurring bills (rent, phone, streaming): a bill comes due on a steady beat, and each time it is
-- paid it becomes an ordinary entry that points back to it through entries.bill_id.
-- anchor: the first due day 'YYYY-MM-DD'; occurrence k is anchor + k·cadence, clamped to the month's
-- last day (a bill on the 31st falls on 28 Feb). next_due: the first occurrence not paid or skipped.
-- mode: 'auto' logs the entry by itself once the day comes; 'ask' waits for "Paid it".
CREATE TABLE bills (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency     TEXT NOT NULL,
  description  TEXT NOT NULL,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  cadence      TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  anchor       TEXT NOT NULL,
  next_due     TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('auto', 'ask')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX bills_user ON bills(user_id, next_due);

-- Stopping a bill keeps the entries that paid it; they simply stop pointing at it.
ALTER TABLE entries ADD COLUMN bill_id TEXT REFERENCES bills(id) ON DELETE SET NULL;
CREATE INDEX entries_bill ON entries(bill_id) WHERE bill_id IS NOT NULL;

-- Habits the person said are not bills ("Not a bill"): folded description + '|' + amount.
CREATE TABLE bill_dismissals (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
