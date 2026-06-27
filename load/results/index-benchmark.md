# Index benchmark — transaction history

Measured, not estimated. Reproduce with `db/benchmark/explain.sql`.

## Method

| | |
| --- | --- |
| Dataset | 500,018 transactions across 200 users / 200 accounts, spread over one year |
| Benchmark account | the account with the most rows: 2,665 transactions |
| Query | `SELECT id, type, symbol, amount, transaction_time FROM transactions WHERE account_id = $1 ORDER BY transaction_time DESC LIMIT 20` |
| Statistics | `ANALYZE transactions` immediately before measuring |
| Environment | PostgreSQL 16 (alpine) in Colima, 4 vCPU / 4 GB VM, on an 8 GB arm64 Mac |
| Isolation | the index is dropped inside a transaction that is rolled back |
| Caching | both runs served entirely from shared buffers (`shared hit`, no `read`), so this measures plan quality rather than disk |

## Result

| | With `idx_transactions_account_time` | Without it |
| --- | --- | --- |
| Execution time | **0.153 ms** | **38.078 ms** |
| Buffers touched | 23 | 2,246 |
| Plan | Index Scan, already ordered | Bitmap Heap Scan → top-N heapsort |
| Rows examined | 20 | 2,665 |

**~249× faster on this query, touching ~98× fewer buffers.**

## What the plans actually say

With the index, Postgres walks `(account_id, transaction_time DESC)` and stops after 20
rows. There is no sort node at all — the index already provides the order the query asks
for, which is the entire reason the index is composite rather than on `account_id` alone.

Without it, Postgres does not fall back to a sequential scan. It uses
`uq_transactions_account_idempotency`, which also begins with `account_id`, to find the
2,665 matching rows — then has to fetch every one of them from the heap and sort them to
find the newest 20. The cost is not in locating the rows; it is in reading 2,665 of them
to return 20.

## Honest limits of this number

- One query, one account, one dataset size. A user with 20 transactions would see
  almost no difference.
- Both runs are fully cached. On a cold cache the gap would be **wider**, not narrower,
  because the 2,246-buffer plan would fault pages in from disk.
- 249× is the ratio for *this* shape of query. It is not a claim about the API's
  end-to-end latency, where JSON serialisation and network time dominate a 0.153 ms
  query.
