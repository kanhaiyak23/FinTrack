# Progress

Single source of truth for what is done and what is next. Update it in the same commit
as the work — a workstream is not "done" until its acceptance criteria are demonstrably
met, not merely until the code exists.

**Status values:** ` ` not started · `~` in progress · `x` done · `!` blocked

**Last updated:** 2026-10-26 — Workstreams A–N complete; workstream O (deployment and API docs) complete and smoke-tested live.

## Current state

All fourteen build workstreams (A–N) are done, and the system is **deployed** at
`https://fintrack-api-nxef.onrender.com` (Swagger UI at `/docs`). It runs as one Render
free web service that starts the API and the worker together, with Postgres on Neon,
MongoDB on Atlas and Redis on Render Key Value. See `docs/deploy.md` and ADR-020.

What exists: authentication, accounts, plans and subscriptions; four transaction types
executed atomically under a row lock with client idempotency and an outbox row; a worker
that publishes the outbox, maintains holdings and daily aggregates, records activity in
MongoDB and builds daily/monthly report snapshots; a fail-open Redis cache; Dockerfiles,
Nginx and compose for the multi-instance topology; seed data, an index benchmark and k6
load tests with recorded methods; an OpenAPI 3 spec served as Swagger UI.

The deployed demo is not the designed topology. API and worker share one 512 MB container
(`WORKER_CONCURRENCY=2`), cannot scale independently, and sleep together when idle, so
scheduled reports run late. The designed topology is the compose `app` profile
(`--scale api=3 --scale worker=2` behind Nginx).

**Immediate next action:** none required. Open items are under Open questions and in the
README's limitations section. Keep `apps/api/src/docs/openapi.js` in step with any route
or schema change.

## Workstreams

| | Workstream | Status | Depends on | Acceptance |
|---|---|---|---|---|
| A | Foundation | `x` | — | ✅ `/health` reports pg + mongo + redis independently |
| B | Authentication | `x` | A | ✅ JWT is the only identity source across all modules |
| C | PostgreSQL / domain | `x` | A | ✅ Full schema + 3 composite indexes migrate onto an empty DB |
| D | Transactions | `x` | C, B | ✅ Forced mid-transaction failure rolls back balance *and* outbox |
| E | Activity events | `x` | D, G | ✅ Every business write emits exactly one event, no duplicates |
| F | Redis / cache | `x` | A | ✅ Redis stopped → analytics still correct from Postgres |
| G | BullMQ / queues | `x` | A, F, D | ✅ Outbox rows published exactly once, survive publisher restart |
| H | Workers | `x` | G | ✅ Same event twice → identical aggregates |
| I | Analytics | `x` | D, F, H | ✅ Fixture returns exact expected holdings and realized P&L |
| J | Reports | `x` | I | ✅ Repeatable job writes snapshot and invalidates cache |
| K | Testing | `x` | continuous | ✅ `npm test` green from clean checkout + `docker compose up -d` |
| L | Docker / Nginx | `x` | A, H | ✅ `--scale api=3 --scale worker=2` serves through Nginx |
| M | Load testing | `x` | L | ✅ Every number carries query, dataset size, hardware, method |
| N | Documentation | `x` | continuous | ✅ Failure-mode table documented and true of the built system |
| O | Deployment and API docs | `x` | A–N | ✅ Live smoke test passes: health, idempotent replay, ownership 404, worker-fed analytics, activity and reports |

## Critical path

`A → C → D → G → H → I → J` — roughly 60% of total effort. B, E, F, K, L, N slot around it.

## Open questions

Three defaults remain unconfirmed (ADR-007 was confirmed 2026-09-19). Each is recorded as ASSUMED in the
decision log and should be confirmed before the dependent workstream starts.

| Decision | Assumed | Confirm before | Cost to change |
|---|---|---|---|
| ADR-006 cost basis | Weighted average | ~~Workstream I~~ **already built in H** | High — migration + rewrite of services/analytics.js |
| ADR-009 cache policy | TTL + worker invalidation | ~~Workstream F~~ **built as assumed** | Low |
| ADR-012 dataset size | ~500k transactions | ~~Workstream M~~ **used as assumed** | Low — reseed |

## Verified claims

Every performance number added here must carry its query, dataset size, hardware and
method, per invariant 10. Entries with no recorded method get deleted, not trusted.

| Claim | Measured | Method | Date |
|---|---|---|---|
| History query, with vs without composite index | 0.153 ms vs 38.078 ms | 500,018 rows, `EXPLAIN ANALYZE`, index dropped in a rolled-back transaction, 4 vCPU / 4 GB Colima VM — `load/results/index-benchmark.md` | 2026-09-19 |
| Cached analytics reads | 5,107 req/s, p95 6.46 ms, 0% failed | k6, 20 VUs, 45 s, 3 API instances behind Nginx, load generator on the same host, one user — `load/results/load-test.md` | 2026-09-19 |
| Deposits under single-row lock contention | 361 req/s, p95 94.22 ms, 0% failed | k6, 10 VUs, 45 s, all VUs on one account — `load/results/load-test.md` | 2026-09-19 |
| Worker drain | 16,437 outbox rows to 0 backlog | 2 worker instances, after the write run — `load/results/load-test.md` | 2026-09-19 |

No performance figure has been recorded for the Render deployment. The 2026-10-26 smoke
test checked behaviour only (see the log), not throughput or latency.

## Log

- **2026-10-26** — Workstream O complete: deployed and smoke-tested. Swagger UI at `/docs`
  from a hand-written OpenAPI 3 spec (18 paths, 22 operations, checked against the route
  files and validated). Render Blueprint for one free web service running API and worker
  via `concurrently --kill-others-on-fail`, Render Key Value for Redis, Neon for Postgres
  (direct string, ADR-020), Atlas for MongoDB. Migrations run in the build step.
  First deploy failed because `MONGODB_URL` still held Atlas's `<db_username>` placeholder
  (the API connects to Mongo eagerly and exits on failure); reproduced locally from a clean
  clone, fixed by correcting the credential. Live smoke test against the deployed URL:
  `/health` all three subsystems up; a repeated `Idempotency-Key` returned 200 with
  `replayed: true` and the same transaction id; an over-balance BUY and an over-large
  withdrawal returned 422 with the balance unchanged; a second user reading the first
  user's account got 404; portfolio, activity and the daily report were populated by the
  worker within seconds, and a second portfolio read returned `x-cache: HIT`. Repo
  history reconciled by rebasing onto the remote's workstreams E–N rather than
  force-pushing.

- **2026-09-19** — Workstream G complete. Dedicated BullMQ Redis connection per process
  (ADR-015). Three queues with `attempts: 3`, exponential backoff from 1s, and retention
  that keeps completed jobs long enough for jobId deduplication to mean something. The
  outbox publisher claims batches with `SELECT ... FOR UPDATE SKIP LOCKED` ordered by
  `occurred_at`, uses the row id as the job id, and sets `published_at` inside the claim
  transaction, so there is no window where a row is claimed but visible to a peer. An
  unroutable row is recorded and skipped; a transport failure abandons the pass and backs
  off (ADR-016). Verified against a real 28-second Redis outage: the process stayed up,
  19 of 20 backlog rows were never touched, and all 20 published exactly once on recovery.
  `jest.config.js` now runs suites serially — the publisher claims every unpublished row
  in the table, so a concurrently running suite writing transactions corrupts its counts.
  90/90 tests pass.
- **2026-09-19** — Added `docs/RUNBOOK.md`: a run-and-verify guide covering setup, both
  run modes, every endpoint, the six hard guarantees, direct database inspection, tests,
  benchmarks, scaling and troubleshooting. Every command in it was executed against this
  codebase before being written down; three that did not work as first drafted were
  corrected (macOS `base64` rejects unpadded base64url, `head -3` misses the retry-after
  header, and `jq` was assumed without being listed as a prerequisite).

  Writing it found a real bug — see the ADR-019 entry above.
- **2026-09-19** — Workstream N complete, and with it all fourteen. Architecture document
  with the failure-mode table, README with measured figures and their caveats, and a
  26-request Postman collection that chains its own auth token and ids. Documented that
  the app containers must be stopped before running tests: they share Postgres and Redis,
  so a running worker consumes jobs the tests count - which is exactly how it presented,
  as five queue tests failing for no visible reason.
- **2026-09-19** — Workstream M complete. Seeded 500,018 transactions in 29.5s. Index
  benchmark shows 0.153 ms vs 38.078 ms with and without the composite index, measured by
  dropping it inside a rolled-back transaction. k6 read-heavy: 5,107 req/s, p95 6.46 ms,
  100% cache hits, 0 failures. Write-heavy with all VUs contending on one account row:
  361 req/s, p95 94.22 ms, 0 failures, and the resulting 16,437 outbox rows drained to
  zero backlog. Caveats recorded alongside every figure.
- **2026-09-19** — Workstream L complete. Multi-stage Dockerfiles for API and worker,
  running unprivileged. Nginx with least_conn in front. Application services sit behind a
  compose profile so `docker compose up -d` still gives just infrastructure for local
  development. Verified with api=3 and worker=2: 60 requests distributed 20/20/20 across
  instances, a JWT issued by one instance accepted by all three, and 12 outbox rows
  processed exactly once by two concurrent publishers - holding landed at exactly 10 units
  after 10 concurrent BUYs.
- **2026-09-19** — Workstream J complete. Daily and monthly snapshots in MongoDB, built
  by a worker from the aggregates and upserted so regeneration replaces rather than
  accumulates. BullMQ repeatable jobs at 00:15 and 00:30 in REPORT_TIMEZONE; the schedule
  lives in Redis so N workers converge on one timetable instead of N. A read with no
  snapshot returns 202 and enqueues generation rather than 404. Fixed a cache-key mismatch
  between API and worker found by a test, and made the API's queue connection lazy after
  discovering that importing the Express app opened a Redis socket. 151/151 tests pass.

  **Known flake:** `domain.test.js › subscribes to an owned plan` failed once in a full
  run and passed in isolation and on re-run. Not diagnosed. Recorded rather than ignored.
- **2026-09-19** — Workstream E complete. Nine event types now emitted, every one inside
  the transaction of the write it describes. The outbox fans out: money events reach both
  the analytics and activity queues, lifecycle events only activity. Activity history is
  in MongoDB, idempotent through a unique index on eventId rather than processed_events,
  because the Mongo write and a Postgres ledger entry cannot share a transaction.
  `GET /activity` paginates by keyset on (occurredAt, eventId). Verified live: 6 events,
  0 unpublished, 6 activity documents, 2 analytics updates. 137/137 tests pass.
- **2026-09-19** — Workstreams F and I complete. Cache-aside helper that never throws;
  every Redis call wrapped so an outage costs latency only. Worker invalidates the three
  per-user analytics keys after the aggregate commit, never inside it. Analytics endpoints
  read the pre-aggregated tables rather than the transaction log. Market value and
  unrealised P&L are returned as null with a stated reason - there is no price feed and
  inventing one would be worse than omitting it. Verified against a genuinely stopped
  Redis container: 200, x-cache MISS, byte-identical payload. 120/120 tests pass.
- **2026-09-19** — Workstream H complete. Real analytics processor maintains
  `portfolio_holdings` and `daily_user_aggregates` with weighted-average cost basis.
  Claim and aggregate update share one transaction, so a mid-apply failure leaves the
  event unclaimed and retryable rather than marked done. Day boundaries computed in
  REPORT_TIMEZONE in SQL. Verified end to end against running API and worker processes:
  4 transactions -> 4 outbox rows -> 0 unpublished -> 4 processed -> holdings 15 units at
  basis 2250 with realised P&L 500, matching hand-computed weighted average. 107/107 tests
  pass.
- **2026-09-19** — Workstream G reviewed and integrated. Review found two runtime faults
  in the producers that the suite could not have caught, because nothing called them yet:
  an illegal `jobId` (BullMQ rejects `:` outside a three-part id) and silent suppression
  of `add` when a completed job with that id is still retained. Both confirmed against
  BullMQ 5.x before changing anything; custom job ids removed (ADR-017) and regression
  tests added. The publisher itself needed no changes: FOR UPDATE SKIP LOCKED, published_at
  set only on a committed pass, and a real 28-second Redis outage survived without data
  loss. 92/92 tests pass.
- **2026-09-19** — Workstream D complete. DEPOSIT/WITHDRAWAL/BUY/SELL execute in one
  `prisma.$transaction`: lock the account row, check idempotency inside the lock, validate
  funds and holdings, insert, adjust balance, write the outbox event. Trade amounts are
  computed server-side from quantity x price, never taken from the client. No short
  selling. Concurrent withdrawals serialise on the row lock. Concurrent retries of one
  idempotency key yield exactly one transaction. Atomicity proven by forcing a real
  NUMERIC overflow mid-transaction and asserting all three writes vanish together.
  80/80 tests pass.
- **2026-09-19** — Workstream C complete. Full schema: accounts, transactions,
  investment_plans, subscriptions, outbox_events, processed_events. Money is
  NUMERIC(20,4) and leaves the API as a string. Seven CHECK constraints enforce business
  rules in the database, including an equivalence that rejects both a BUY without a symbol
  and a DEPOSIT carrying one. Partial unique index gives one active subscription per plan
  while keeping cancellation history. Partial index on unpublished outbox rows keeps the
  publisher's scan proportional to the backlog. Keyset pagination throughout. Idempotency
  keys scoped per account (ADR-014, deviates from the source plan). 56/56 tests pass.
- **2026-09-19** — Workstream B complete. Register/login/me with bcrypt (12 rounds) and
  JWT. Duplicate email resolved by unique constraint, not check-then-insert, so concurrent
  registrations cannot both succeed. Login returns one message for both unknown-email and
  wrong-password, with a dummy bcrypt comparison so the timing matches too. Token payload
  carries only `sub`, `iss`, `iat`, `exp`. Unknown request fields are stripped by zod
  rather than persisted. 25/25 tests pass.
- **2026-09-19** — Workstream A complete. Colima installed and running. Compose brings up
  Postgres/Mongo/Redis with health checks. API validates config and fails fast on a missing
  or short `JWT_SECRET`. `/health` probes each subsystem independently: Redis down returns
  200 with `redis: down`, Postgres down returns 503. `users` table and migration `001_users`
  pulled forward from C so Prisma could generate a client. 8/8 tests pass.
- **2026-09-19** — Source plan (26pp) analysed. Machine inspected: no container runtime,
  no Postgres/Mongo/Redis. Existing repo found to be an incompatible prototype.
  Thirteen decisions recorded. Fourteen workstreams defined. Awaiting approval.
