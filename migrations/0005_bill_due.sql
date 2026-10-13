-- The occurrence a bill payment paid ('YYYY-MM-DD'), so deleting the payment can move the bill back
-- to it. NULL for entries that paid no bill, and for payments logged before this column existed.
ALTER TABLE entries ADD COLUMN bill_due TEXT;
