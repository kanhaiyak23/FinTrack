# FinTrack

Transaction analytics and reporting backend. A modular monolith with separate worker
processes, built around transactional correctness, asynchronous processing, caching and
horizontal scaling.

Users hold accounts, move money (deposit, withdrawal, buy, sell), subscribe to investment
plans, and read analytics and reports derived from that activity. Expensive work happens
off the request path.

**Node.js · Express · PostgreSQL · MongoDB · Redis · BullMQ · Prisma · Docker · Nginx**

## Running it

```bash
# Infrastructure only, for local development
docker compose up -d
npm install
cp .env.example .env            # set JWT_SECRET: openssl rand -hex 32
npx prisma migrate deploy
npm run dev:api                 # :4000
npm run dev:worker              # separate terminal

# Or the whole stack, as deployed
docker compose --profile app up -d --scale api=3 --scale worker=2
curl -s localhost:8080/health | jq
```

Requires Node 20+ and a container runtime. Developed against
[Colima](https://github.com/abiosoft/colima): `brew install colima docker docker-compose`
then `colima start --cpu 4 --memory 4 --disk 40`.

## API

All routes except `/health` and `/auth/*` need `Authorization: Bearer <token>`.

| Method | Endpoint | Notes |
| --- | --- | --- |
| `POST` | `/auth/register` · `/auth/login` | Returns a JWT carrying only an identity |
| `GET` | `/users/me` | |
| `POST` `GET` | `/accounts` · `/accounts/:id` | |
| `POST` | `/transactions` | DEPOSIT · WITHDRAWAL · BUY · SELL. Honours `Idempotency-Key` |
| `GET` | `/transactions` · `/transactions/:id` | Paginated; filter by account, type, symbol, dates |
| `POST` `GET` `PATCH` | `/plans` · `/plans/:id` | |
| `POST` `GET` `DELETE` | `/subscriptions` · `/subscriptions/:id` | |
| `GET` | `/activity` | Event history from MongoDB |
| `GET` | `/analytics/portfolio` · `/analytics/pnl` · `/analytics/activity` | Cached; `x-cache` header reports HIT/MISS |
| `GET` | `/reports/daily` · `/reports/monthly` | 202 while a snapshot is still being generated |
| `GET` | `/health` | Per-subsystem status |

A Postman collection is in [`postman/`](postman/) — run the folders in order and the JWT,
account and plan ids are captured automatically.

## How it works

A write commits its business change **and** its event in one database transaction. A
worker publishes those events to queues, updates aggregates, records activity and
generates reports. The API never waits for any of it.

```
POST /transactions ──► one transaction: lock account, insert, update balance, write outbox
                       ──► 201, done
outbox publisher   ──► SELECT … FOR UPDATE SKIP LOCKED ──► queues
workers            ──► aggregates (Postgres) · activity (MongoDB) · cache invalidation
```

**To run it and check every feature yourself, follow
[`docs/RUNBOOK.md`](docs/RUNBOOK.md)** — it walks the whole system end to end with the
expected output at each step.

Full diagram, consistency model and failure-mode table:
[`docs/architecture.md`](docs/architecture.md).
Decisions with their rejected alternatives: [`docs/decisions.md`](docs/decisions.md).

Some properties worth knowing before reading the code:

- **Money is never a JavaScript number** — `NUMERIC(20,4)` in Postgres, Prisma `Decimal`
  in code, decimal strings over the wire.
- **Identity comes only from the JWT.** No endpoint reads a user id from a request.
- **Concurrent withdrawals cannot both overdraw** — `SELECT … FOR UPDATE`, with
  `CHECK (balance >= 0)` as the database-level backstop.
- **A retried POST creates one transaction**, whether the retries are sequential or
  simultaneous.
- **Redis failing costs latency, not correctness** — analytics fall through to Postgres.
- **Workers are idempotent**, so at-least-once delivery is safe.

## Tests

```bash
docker compose up -d          # infrastructure only
docker compose --profile app stop api worker nginx   # if the full stack is running
npm test
```

**Stop the app containers before running tests.** They share the same Postgres and Redis,
so a running worker will consume the jobs a test is counting and the failures will look
like bugs in the code under test.

151 tests against real PostgreSQL, MongoDB and Redis rather than mocks — the behaviour
worth testing here (transactions, row locking, idempotency, cache fallback) only exists
against the real thing. They run serially because several suites truncate a shared
database.

Some of what they assert: a forced failure mid-transaction rolls back the balance *and*
the outbox row; two concurrent withdrawals cannot both succeed; five simultaneous retries
of one idempotency key produce one transaction; analytics stay correct with Redis
genuinely stopped; the same event processed twice leaves aggregates byte-identical.

## Measured performance

Every figure below was produced by a run that is reproducible, with its method recorded
in [`load/results/`](load/results/). Nothing here is extrapolated.

| Measurement | Result | Method |
| --- | --- | --- |
| History query, with vs without the composite index | **0.153 ms vs 38.078 ms** | 500,018 rows, `EXPLAIN ANALYZE`, index dropped inside a rolled-back transaction |
| Cached analytics reads | **5,107 req/s, p95 6.46 ms**, 0% failed | k6, 20 VUs, 45s, 3 API instances behind Nginx |
| Deposits under single-row lock contention | **361 req/s, p95 94.22 ms**, 0% failed | k6, 10 VUs, 45s, all VUs on one account |
| Worker drain | **16,437 outbox rows → 0 backlog** | 2 worker instances |

**What these are not:** capacity claims. The load generator shares four cores with the
stack, the read test runs at a 100% cache hit rate against a single user, and 500k rows
fit comfortably in page cache at this VM size. The caveats are recorded next to the
numbers rather than left out of them.

## Known limitations

- **Access tokens only.** No refresh tokens; documented as an MVP scope decision.
- **No market price feed.** Market value and unrealised P&L are returned as `null` with a
  stated reason rather than derived from cost basis and presented as a valuation.
- **Weighted-average cost basis**, not FIFO. One documented method, stated in the P&L
  response.
- **No delivery channel for notifications.** The processor records what would have been
  sent; nothing leaves the machine.
- **Analytics are eventually consistent**, typically within two seconds of a write.
- **One known flaky test**, recorded in [`docs/progress.md`](docs/progress.md) rather than
  quietly re-run.

## Layout

```
apps/api/src/       routes → controller → service → repository, per module
apps/worker/src/    processors, queue wiring, aggregation services
prisma/             schema and migrations
nginx/              load balancer config
load/               k6 scripts and recorded results
db/benchmark/       EXPLAIN ANALYZE harness
tests/              integration and unit
docs/               architecture, decisions, progress
```

`CLAUDE.md` holds the conventions and the ten invariants any change has to preserve.

## License

MIT
