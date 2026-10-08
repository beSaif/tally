-- Per-category monthly budgets and the fixed-cost flag (Analytics drill-down, monthly report).
-- budget_cents: NULL = no budget. fixed: 1 = a fixed cost (rent, bills), told apart from
-- day-to-day spending.
ALTER TABLE categories ADD COLUMN budget_cents INTEGER;
ALTER TABLE categories ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0;

-- Bills are fixed costs out of the box, as for new accounts (FIXED_CATEGORIES).
UPDATE categories SET fixed = 1 WHERE name IN ('Bills', 'Factures');
