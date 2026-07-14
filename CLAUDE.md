# CLAUDE.md — FinTrack

Operating guide for anyone (human or agent) working in this repository.
Read this before changing code. If a change contradicts something here, update this
file in the same commit or don't make the change.

## What this is

FinTrack is a transaction analytics and reporting backend: users hold accounts, move
money (DEPOSIT / WITHDRAWAL / BUY / SELL), subscribe to investment plans, and read
analytics and reports derived from that activity.

It is a **modular monolith plus separate worker processes**. It is not microservices.
Do not add Kafka, Kubernetes, or a service mesh. Every technology here solves a stated
problem; anything that doesn't earn its place gets removed.

## Architecture

```
Client -> Nginx -> API instances (stateless, N of them)
                        |
                        +-- PostgreSQL   source of truth for business data
                        +-- Redis        cache + BullMQ backend
                        +-- MongoDB      activity events + report snapshots
                        |
                   BullMQ queues -> Worker processes (analytics, reports,
                                    notifications, outbox publisher)
```

PostgreSQL is authoritative. Redis is an optimization. MongoDB holds derived and
document-shaped data. If those three ever disagree, PostgreSQL wins.

## Non-negotiable invariants

Violating any of these is a bug, regardless of whether tests pass.

1. **Money is never a JavaScript `Number`.** `Decimal(20,4)` in Postgres, Prisma
   `Decimal` in code. No `+`, `-`, `*` on monetary values — use the Decimal API.
2. **Identity comes only from the JWT.** Never read `user_id` from a request body,
   query string, or header. `req.user.userId` is the single source.
3. **Ownership is checked on every read and write of a user-scoped row.** Joining
   through `accounts.user_id` is the pattern; a bare `WHERE id = $1` on a user-owned
   table is a security bug.
4. **One business operation is one database transaction.** A balance change and its
   transaction row and its outbox row commit together or not at all.
5. **Concurrent balance changes take a row lock.** `SELECT ... FOR UPDATE` on the
   account before computing the new balance. Read-then-write without a lock is a
   lost-update bug.
6. **Events are emitted through the outbox**, inside the business transaction. Never
   call `queue.add()` and a database write as two independent steps.
7. **Workers are idempotent.** Every processor checks `processed_events` before
   mutating aggregates. Processing the same event twice must leave identical state.
8. **Cache failures degrade, never break.** Every Redis call is wrapped; on error, log
   and fall through to PostgreSQL. A Redis outage must not produce a 5xx.
9. **API instances are stateless.** No in-memory sessions, counters, caches, or
   timers that matter. Anything stateful goes in Postgres or Redis.
10. **No performance claim without a recorded measurement.** Query, dataset size,
    hardware, and method go in `load/results/` next to the number.

## Layout

```
apps/api/src/
  config/        env parsing and validation, fails fast on missing vars
  db/            prisma client, mongo client, redis client
  middleware/    auth, error handler, request id, logging, validation
  modules/<name>/  routes -> controller -> service -> repository
  queues/        producers only; the API never processes jobs
  app.js         express wiring
  server.js      entrypoint
apps/worker/src/
  processors/    one file per job type
  services/      aggregation logic shared by processors
  worker.js      entrypoint
prisma/          schema + migrations
db/benchmark/    EXPLAIN ANALYZE captures
nginx/           load balancer config
load/            k6 scripts and recorded results
tests/           integration and unit
docs/            architecture, decisions, progress
```

**Module rule:** a module owns its routes, controller, service, repository and
validation schema. Controllers do no business logic. Services do no SQL. Repositories
do no HTTP. Cross-module access goes through the other module's service, never its
repository.

## Conventions

- JavaScript, ESM (`"type": "module"`), Node 20+. No TypeScript, no build step.
- Prisma for data access; `$queryRaw` only for `FOR UPDATE` and `EXPLAIN` (comment why).
- Validation at the API boundary, every external input, no exceptions.
- Errors: throw `ApiError(status, message, details)`; one central handler formats them.
  No `try/catch` that returns a response from inside a controller.
- Logging: `pino`, structured, with a request id. Never log tokens, passwords or
  full request bodies containing credentials.
- Status codes: 200/201 success, 400 malformed, 401 unauthenticated, 403 unauthorized,
  404 missing, 409 conflict, 422 validation, 500 unexpected.
- Pagination on every list endpoint. Stable sort, cursor-based where ordering allows.
- Secrets come from the environment. Nothing hardcoded, `.env` never committed.

## Commands

```bash
docker compose up -d                  # postgres, mongo, redis
npm run migrate -w apps/api           # prisma migrate deploy
npm run dev -w apps/api               # API on :4000
npm run dev -w apps/worker            # worker process
npm test                              # jest + supertest, needs infra up.
                                      # Stop the app profile first: a running worker
                                      # consumes jobs the tests count.
npm run seed -- --transactions 500000 # benchmark dataset
docker compose up --scale api=3 --scale worker=2   # full stack behind nginx :8080
```

## Before you commit

- Does it hold all ten invariants above?
- Does a new user-scoped endpoint have an ownership test?
- Did a decision get made? Add it to `docs/decisions.md`.
- Did a workstream advance? Update `docs/progress.md`.
- Any number in a doc: is it measured, with its method recorded?
