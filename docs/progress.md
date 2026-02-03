# Progress

Single source of truth for what is done and what is next. Update it in the same commit
as the work — a workstream is not "done" until its acceptance criteria are demonstrably
met, not merely until the code exists.

**Status values:** ` ` not started · `~` in progress · `x` done · `!` blocked

**Last updated:** 2026-09-19 — Workstream A complete and verified.

## Current state

Workstream A is done. Colima runs a 4 CPU / 4 GB VM; Postgres 16, MongoDB 8 and Redis 7
come up healthy under `docker compose`. The API boots, validates its environment, and
reports all three subsystems at `/health`. Eight tests pass.

The prototype from `69efd80` has been removed from the tree (still in history, ADR-013).

**Immediate next action:** Workstream C — full Prisma schema, constraints and indexes.

## Workstreams

| | Workstream | Status | Depends on | Acceptance |
|---|---|---|---|---|
| A | Foundation | `x` | — | ✅ `/health` reports pg + mongo + redis independently |
| B | Authentication | ` ` | A, C | JWT is the only identity source across all modules |
| C | PostgreSQL / domain | ` ` | A | Full schema + 3 composite indexes migrate onto an empty DB |
| D | Transactions | ` ` | C, B | Forced mid-transaction failure rolls back balance *and* outbox |
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

Four defaults were taken without owner confirmation. Each is recorded as ASSUMED in the
decision log and should be confirmed before the dependent workstream starts.

| Decision | Assumed | Confirm before | Cost to change |
|---|---|---|---|
| ADR-006 cost basis | Weighted average | Workstream I | High — FIFO needs a lots table |
| ADR-007 trades move cash | Yes, BUY debits | Workstream D | High — rewrites transaction service |
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

- **2026-09-19** — Workstream A complete. Colima installed and running. Compose brings up
  Postgres/Mongo/Redis with health checks. API validates config and fails fast on a missing
  or short `JWT_SECRET`. `/health` probes each subsystem independently: Redis down returns
  200 with `redis: down`, Postgres down returns 503. `users` table and migration `001_users`
  pulled forward from C so Prisma could generate a client. 8/8 tests pass.
- **2026-09-19** — Source plan (26pp) analysed. Machine inspected: no container runtime,
  no Postgres/Mongo/Redis. Existing repo found to be an incompatible prototype.
  Thirteen decisions recorded. Fourteen workstreams defined. Awaiting approval.
