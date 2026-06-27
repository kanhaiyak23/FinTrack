-- Reproducible index benchmark. Run against a seeded database:
--
--   npm run seed -- --users=200 --transactions=500000
--   docker compose exec -T postgres psql -U fintrack -d fintrack -f db/benchmark/explain.sql
--
-- The DROP runs inside a transaction that is rolled back, so the index is restored even
-- if the script fails partway. Never run the drop outside a transaction on anything you
-- care about.

\set account_id '(SELECT account_id FROM transactions GROUP BY account_id ORDER BY count(*) DESC LIMIT 1)'

ANALYZE transactions;

\echo '=== transaction history WITH idx_transactions_account_time ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, type, symbol, amount, transaction_time
FROM transactions
WHERE account_id = (SELECT account_id FROM transactions GROUP BY account_id ORDER BY count(*) DESC LIMIT 1)
ORDER BY transaction_time DESC
LIMIT 20;

\echo '=== the same query WITHOUT it ==='
BEGIN;
DROP INDEX idx_transactions_account_time;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, type, symbol, amount, transaction_time
FROM transactions
WHERE account_id = (SELECT account_id FROM transactions GROUP BY account_id ORDER BY count(*) DESC LIMIT 1)
ORDER BY transaction_time DESC
LIMIT 20;
ROLLBACK;
