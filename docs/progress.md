# Progress

Single source of truth for what is done and what is next. Update it in the same commit
as the work — a workstream is not "done" until its acceptance criteria are demonstrably
met, not merely until the code exists.

**Status values:** ` ` not started · `~` in progress · `x` done · `!` blocked

**Last updated:** 2026-09-19 — Workstreams A, B, C and D complete and verified.

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
in the same commit. **Outbox rows currently accumulate with `published_at = NULL`: nothing
consumes them until workstream G.**

The prototype from `69efd80` has been removed from the tree (still in history, ADR-013).

**Immediate next action:** Workstream G — BullMQ queues and the outbox publisher. Outbox rows are accumulating unpublished; nothing drains them yet.

## Workstreams

| | Workstream | Status | Depends on | Acceptance |
|---|---|---|---|---|
| A | Foundation | `x` | — | ✅ `/health` reports pg + mongo + redis independently |
| B | Authentication | `x` | A | ✅ JWT is the only identity source across all modules |
| C | PostgreSQL / domain | `x` | A | ✅ Full schema + 3 composite indexes migrate onto an empty DB |
| D | Transactions | `x` | C, B | ✅ Forced mid-transaction failure rolls back balance *and* outbox |
| E | Activity events | ` ` | D, G | Every business write emits exactly one event, no duplicates |
| F | Redis / cache | ` ` | A | Redis stopped → analytics still correct from Postgres |
| G | BullMQ / queues | ` ` | A, F, D | Outbox rows published exactly once, survive publisher restart |
| H | Workers | ` ` | G | Same event twice → identical aggregates |
| I | Analytics | ` ` | D, F, H | Fixture returns exact expected holdings and realized P&L |
| J | Reports | ` ` | I | Repeatable job writes snapshot and invalidates cache |
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
| ADR-006 cost basis | Weighted average | Workstream I | High — FIFO needs a lots table |
| ADR-009 cache policy | TTL + worker invalidation | Workstream F | Low |
| ADR-012 dataset size | ~500k transactions | Workstream M | Low — reseed |

## Verified claims

Nothing measured yet. Every performance number added here must carry its query, dataset
size, hardware and method, per invariant 10. Entries with no recorded method get deleted,
not trusted.

| Claim | Measured | Method | Date |
|---|---|---|---|
| — | — | — | — |

## Log

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
