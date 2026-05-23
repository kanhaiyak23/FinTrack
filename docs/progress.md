# Progress

Single source of truth for what is done and what is next. Update it in the same commit
as the work — a workstream is not "done" until its acceptance criteria are demonstrably
met, not merely until the code exists.

**Status values:** ` ` not started · `~` in progress · `x` done · `!` blocked

**Last updated:** 2026-09-19 — Workstreams A, B, C, D and G complete and verified.

## Current state

Workstreams A and B are done. Colima runs a 4 CPU / 4 GB VM; Postgres 16, MongoDB 8 and
Redis 7 come up healthy under `docker compose`. The API boots, validates its environment,
reports all three subsystems at `/health`, and serves register / login / me with JWT
authentication. 25 tests pass.

B did not need C after all: the `users` table arrived with A, so authentication was
unblocked without the rest of the schema.

C added the remaining seven tables with seven CHECK constraints, two partial indexes and
the three composite indexes from the source plan.

D implements all four transaction types inside a single database transaction with
`SELECT ... FOR UPDATE` on the account row, client idempotency, and an outbox row written
in the same commit.

G drains the outbox. A publisher loop in the worker claims unpublished rows with
`FOR UPDATE SKIP LOCKED`, enqueues each one onto its queue using the row id as the BullMQ
job id, and marks `published_at` in the same transaction as the claim. Three queues
(`analytics`, `reports`, `notifications`) exist with producers in the API and placeholder
processors in the worker. **Those processors log and return: the real analytics and report
logic is workstream H.**

The prototype from `69efd80` has been removed from the tree (still in history, ADR-013).

**Immediate next action:** Workstream L — Dockerfiles, Nginx, multi-instance compose.
real analytics and report logic. The queue topology, the idempotency helper
(`apps/worker/src/services/idempotency.js`) and the shutdown path are already in place.

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
| K | Testing | ` ` | continuous | `npm test` green from clean checkout + `docker compose up -d` |
| L | Docker / Nginx | ` ` | A, H | `--scale api=3 --scale worker=2` serves through Nginx |
| M | Load testing | ` ` | L | Every number carries query, dataset size, hardware, method |
| N | Documentation | ` ` | continuous | Failure-mode table documented and true of the built system |

## Critical path

`A → C → D → G → H → I → J` — roughly 60% of total effort. B, E, F, K, L, N slot around it.

## Open questions

Three defaults remain unconfirmed (ADR-007 was confirmed 2026-09-19). Each is recorded as ASSUMED in the
decision log and should be confirmed before the dependent workstream starts.

| Decision | Assumed | Confirm before | Cost to change |
|---|---|---|---|
| ADR-006 cost basis | Weighted average | ~~Workstream I~~ **already built in H** | High — migration + rewrite of services/analytics.js |
| ADR-009 cache policy | TTL + worker invalidation | ~~Workstream F~~ **built as assumed** | Low |
| ADR-012 dataset size | ~500k transactions | Workstream M | Low — reseed |

## Verified claims

Nothing measured yet. Every performance number added here must carry its query, dataset
size, hardware and method, per invariant 10. Entries with no recorded method get deleted,
not trusted.

| Claim | Measured | Method | Date |
|---|---|---|---|
| — | — | — | — |

## Log

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
