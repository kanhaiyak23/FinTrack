# Decision Log

One entry per architectural decision. Append, never rewrite history — if a decision is
reversed, add a new entry that supersedes the old one and mark the old one accordingly.

Format: context, decision, consequences, alternatives rejected.

Status values: ACCEPTED · ASSUMED (default taken, owner has not confirmed) ·
SUPERSEDED · REJECTED

---

## ADR-001 — Modular monolith plus separate workers
**Status:** ACCEPTED

**Context.** The system needs asynchronous processing for analytics and reports, which
invites a microservices design. The project has a 2–3 day budget and must be explainable
in an interview.

**Decision.** One Express application organised into feature modules, plus separate
worker processes communicating over BullMQ/Redis. API and worker are different processes
and scale independently.

**Consequences.** Demonstrates distributed processing without per-service deployment,
networking and observability overhead. Honest description: "a backend with asynchronous
processing", not "a microservices platform".

**Rejected.** Microservices per domain — operational cost with no benefit at this size.
Kafka — a queue is sufficient; Kafka solves problems this system does not have.

---

## ADR-002 — Colima as container runtime
**Status:** ACCEPTED

**Context.** The development machine had no container runtime. Postgres, MongoDB, Redis,
Nginx and the load test all need one, and without it nothing is verifiable.

**Decision.** Colima with the Docker CLI and Compose plugin.

**Consequences.** Full `docker compose` support, so multi-instance API, Nginx and load
tests are genuinely runnable. Open source, no GUI, no licensing questions. CLI only.

**Rejected.** Docker Desktop — largest install, licensing questions at scale.
OrbStack — good, but a GUI is not needed. Native brew services — would leave the compose
file, Nginx config and all scaling claims untested.

---

## ADR-003 — Prisma for data access
**Status:** ACCEPTED

**Context.** The spec permits either an ORM or a driver with parameterized SQL.

**Decision.** Prisma, with `$queryRaw` escape hatches for `SELECT ... FOR UPDATE` and
`EXPLAIN ANALYZE`.

**Consequences.** Fast schema and migration workflow, parameterized by default. Cost:
the generated SQL must still be understood and defensible, and row locking and query
plans need raw escape hatches, each of which carries a comment explaining why.

**Rejected.** node-postgres with hand-written SQL — a better interview story for SQL
specifically, but slower to build within the time budget.

---

## ADR-004 — JavaScript ESM, not TypeScript
**Status:** ACCEPTED

**Context.** Money handling is the highest-risk code here and types catch a real subset
of those bugs, but every file and both Dockerfiles pay for the build step.

**Decision.** JavaScript with ES modules, Node 20+.

**Consequences.** No build step, simpler images, faster iteration. Money safety comes
instead from `Decimal(20,4)` in the database and Prisma `Decimal` in code — enforced by
review and by invariant 1 in CLAUDE.md rather than by a compiler.

**Rejected.** TypeScript — better safety, rejected on time budget.

---

## ADR-005 — Transactional outbox from day one
**Status:** ACCEPTED

**Context.** Writing to Postgres and separately enqueuing a job is a dual-write: either
can fail independently, silently losing analytics events. The source plan marks the
outbox as a stretch goal.

**Decision.** Build it immediately. Business writes insert an `outbox_events` row inside
the same transaction; a publisher worker polls unpublished rows, enqueues them, and marks
them published.

**Consequences.** At-least-once delivery with no lost events, which pairs with worker
idempotency (ADR-008) to give effectively-once processing. Roughly 60 extra lines. Chosen
now because retrofitting it changes how every service emits events.

**Rejected.** Enqueue-after-commit with retries — simpler, but loses events on a crash
between commit and enqueue.

---

## ADR-006 — Weighted-average cost basis for P&L
**Status:** ASSUMED — owner has not confirmed

**Context.** Realized P&L needs exactly one documented cost-basis method.

**Decision.** Weighted average: `average_buy_price = total_buy_cost / total_buy_quantity`,
realized P&L on SELL is `(sell_price - average_buy_price) x quantity`.

**Consequences.** Needs only running totals per symbol, no per-lot state. Matches the
portfolio formula already in the source plan. Not tax-accurate for real use; documented
as a deliberate simplification.

**Rejected.** FIFO — more realistic, requires a `lots` table and consumption logic on
every SELL. Switching later is a migration plus an analytics rewrite.

---

## ADR-007 — Trades move the cash balance
**Status:** ASSUMED — owner has not confirmed

**Context.** The schema gives accounts a `balance` and transactions a symbol, quantity
and price, but never states whether a BUY debits cash.

**Decision.** One cash balance per account. DEPOSIT and SELL credit it; WITHDRAWAL and
BUY debit it. A BUY exceeding available balance is rejected exactly like an overdraft.
Holdings are derived from BUY/SELL quantities, not stored as truth.

**Consequences.** Balances stay meaningful and P&L is computable against real cash. Every
transaction type flows through the same locked-row update path.

**Rejected.** Trades that don't touch the balance — simpler, but balance becomes
meaningless and overdraft rules only apply to half the transaction types.

---

## ADR-008 — Idempotency ledger in Postgres, not Redis
**Status:** ACCEPTED

**Context.** BullMQ delivers at least once. Workers mutate aggregates, so a redelivery
must not double-count.

**Decision.** A `processed_events` table keyed by event id, checked and written inside the
same transaction as the aggregate update.

**Consequences.** Survives a Redis flush or restart, which a Redis SET key would not.
Costs one indexed lookup per job. Client-facing writes are separately protected by a
partial unique index on `transactions.idempotency_key`.

**Rejected.** Redis SETNX — faster, but not durable, and durability is the entire point.

---

## ADR-009 — Cache: TTL plus worker-driven invalidation, fail-open
**Status:** ASSUMED — owner has not confirmed

**Context.** Analytics reads are expensive and repeated. Staleness right after a trade is
the visible failure mode.

**Decision.** Cache-aside with a 600s TTL as the safety net, plus targeted key deletion by
the worker after it updates affected aggregates. Every Redis call is wrapped: on error,
log and fall through to Postgres.

**Consequences.** Fresh data shortly after a write, bounded staleness otherwise, and a
Redis outage costs latency rather than correctness or availability.

**Rejected.** TTL only — up to 10 minutes stale after a trade. Write-through refresh —
no cold miss, but the worker recomputes aggregates nobody may read.

---

## ADR-010 — Access tokens only, no refresh tokens
**Status:** ACCEPTED

**Context.** Refresh-token infrastructure is real work and the source plan explicitly
calls it optional for this scope.

**Decision.** Short-lived JWT access tokens only. No refresh endpoint, no token store.

**Consequences.** Simple and stateless, so API instances stay interchangeable. Users
re-authenticate on expiry. Documented in the README as an MVP limitation, not an oversight.

---

## ADR-011 — Store UTC, report in a configured timezone
**Status:** ACCEPTED

**Context.** Daily and monthly report boundaries are meaningless without a stated timezone,
and the source plan requires documenting it.

**Decision.** All timestamps stored in UTC. Report period boundaries computed in
`REPORT_TIMEZONE`, defaulting to `Asia/Kolkata`.

**Consequences.** One place to change, no ambiguity about what "daily" means. Report
snapshots record the timezone they were generated under.

---

## ADR-012 — Benchmark against ~500k transactions
**Status:** ASSUMED — owner has not confirmed

**Context.** Index measurements on small tables prove nothing: the planner ignores the
index and the numbers are noise.

**Decision.** Seed roughly 500,000 transactions and 2,000,000 activity events for all
`EXPLAIN ANALYZE` and k6 runs.

**Consequences.** Index effects are real and visible; seeding takes a couple of minutes
and a few hundred MB. Every recorded figure carries dataset size, query and method.

**Rejected.** ~50k — seeds instantly, effects too small to defend. ~2M — best numbers,
disproportionate seed time for this scope.

---

## ADR-013 — Replace the existing repository in place
**Status:** ACCEPTED

**Context.** `kanhaiyak23/FinTrack` already held an in-memory Express prototype sharing
only the name with this design.

**Decision.** Keep the repository and its URL; land the new architecture as a fresh commit
on `main`. The prototype remains in history at `69efd80`.

**Consequences.** One repository, one URL, visible evolution. The prototype is recoverable
from history but is not a foundation and should not be extended.
