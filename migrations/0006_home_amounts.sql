-- What an entry counts for in the person's own currency (settings.currency). An entry paid in
-- another currency is converted at the reference rate of its day. NULL while no rate is known
-- (the rate service was unreachable): totals then count amount_cents as it is, and the next read
-- of that period fills it in. Entries in another currency are filled in the same way after this.
ALTER TABLE entries ADD COLUMN home_cents INTEGER;
UPDATE entries SET home_cents = amount_cents
  WHERE currency = (SELECT s.currency FROM settings s WHERE s.user_id = entries.user_id);

-- Reference exchange rates by day, shared by every account: units of `currency` per euro
-- (EUR itself is 1). `day` is the day asked for; weekends and holidays hold the last rate before.
CREATE TABLE fx_rates (
  day      TEXT NOT NULL,
  currency TEXT NOT NULL,
  per_eur  REAL NOT NULL CHECK (per_eur > 0),
  PRIMARY KEY (day, currency)
) WITHOUT ROWID;
