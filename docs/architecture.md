# FinTrack — Architecture

How the system is put together, why each piece is there, and what happens when each one
fails. Decisions with alternatives are recorded separately in
[`decisions.md`](decisions.md).

## Shape

```
                      ┌──────────────┐
                      │   Client     │
                      └──────┬───────┘
                             │ HTTP
                      ┌──────▼───────┐
                      │    Nginx     │  least_conn, :8080
                      └──────┬───────┘
              ┌──────────────┼──────────────┐
         ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
         │  API 1  │    │  API 2  │    │  API 3  │   stateless, :4000
         └────┬────┘    └────┬────┘    └────┬────┘
              └──────────────┼──────────────┘
                 ┌───────────┼───────────┐
          ┌──────▼─────┐ ┌───▼────┐ ┌────▼─────┐
          │ PostgreSQL │ │ Redis  │ │ MongoDB  │
          │ source of  │ │ cache  │ │ activity │
          │ truth      │ │ +queue │ │ +reports │
          └──────┬─────┘ └───┬────┘ └────▲─────┘
                 │           │           │
                 │     ┌─────▼───────────┴─────┐
                 └────►│   Worker × N          │
                outbox │  outbox publisher     │
                       │  analytics · activity │
                       │  reports · notify     │
                       └───────────────────────┘
```

Two process types, not six services. The API answers requests; the worker does everything
expensive. They share a database and a queue and nothing else, which is enough to
demonstrate asynchronous distributed processing without the operational cost of
microservices.

## The write path

A deposit, end to end:

```
POST /transactions
  │
  ├─ validate at the boundary (zod, strict on money operations)
  ├─ requireAuth → req.user.userId          ← the only source of identity
  │
  └─ prisma.$transaction:
       ├─ SELECT … FOR UPDATE on the account  ← ownership AND lock in one statement
       ├─ check idempotency key inside the lock
       ├─ check funds / holdings
       ├─ INSERT transaction
       ├─ UPDATE balance
       └─ INSERT outbox_events               ← same commit as the change it describes
     COMMIT
  │
  └─ 201 (or 200 for a replay)               ← the API is done; nothing waits on a worker
```

Then, independently:

```
outbox publisher (worker)
  ├─ SELECT … FOR UPDATE SKIP LOCKED         ← two publishers take disjoint rows
  ├─ enqueue to every destination queue      ← jobId = outbox row id
  └─ UPDATE published_at                     ← only after every enqueue succeeded

analytics processor            activity processor
  ├─ claim in processed_events   ├─ insert into MongoDB
  ├─ update aggregates           └─ unique index on eventId is the guard
  │  (one transaction)
  └─ invalidate cache keys       (different guard, different database — ADR-018)
```

## Why each technology is here

| Component | Job | Why not something else |
| --- | --- | --- |
| **PostgreSQL** | Users, accounts, transactions, plans, subscriptions, outbox, aggregates | Money needs ACID transactions, foreign keys and CHECK constraints. A document store would put referential integrity in application code. |
| **Redis** | Analytics cache + BullMQ backend | Sub-millisecond reads for expensive aggregates, and a queue that already exists rather than a second piece of infrastructure. |
| **BullMQ** | Retries, backoff, failed-set visibility | A hand-rolled polling loop would need all three re-implemented, badly. |
| **MongoDB** | Activity events, report snapshots | Event metadata genuinely differs by type — a trade has symbol/quantity/price, a login has neither. A relational table would be mostly NULL. |
| **Nginx** | Load balancing across API instances | Makes the stateless claim testable rather than asserted. |
| **Prisma** | Schema, migrations, type-safe access | With `$queryRaw` escape hatches for `FOR UPDATE` and `EXPLAIN`, which an ORM cannot express. |

## Consistency model

| Property | Where it comes from |
| --- | --- |
| A balance change and its transaction row are atomic | One `prisma.$transaction` |
| Concurrent withdrawals cannot both overdraw | `SELECT … FOR UPDATE` on the account row |
| A negative balance is impossible | `CHECK (balance >= 0)` — the database, not the service |
| A retried POST creates one transaction | `UNIQUE(account_id, idempotency_key)` + a lookup inside the lock |
| An event is never lost between commit and queue | Transactional outbox (ADR-005) |
| A job delivered twice changes nothing twice | `processed_events`, or a unique index for the Mongo path |
| Analytics are eventually consistent | By design — the API never waits for a worker |

Analytics lag the write by the publisher's poll interval plus processing, typically under
two seconds. That is the deliberate trade: the write path stays fast, and the read path is
allowed to be slightly behind.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| **PostgreSQL down** | Writes fail with 5xx. `/health` returns 503. Nothing pretends to succeed. |
| **Redis down** | Analytics still correct, served from Postgres, `x-cache: MISS`. `/health` stays 200 with `redis: down`. Queue processing pauses and resumes; no outbox row is lost because `published_at` is only set on a committed pass. Verified against a stopped container. |
| **MongoDB down** | Money operations unaffected. Activity writes fail and retry; the events wait in the outbox. |
| **Worker crashes** | In-flight jobs return to the queue after their lock expires. Unpublished outbox rows stay unpublished. Nothing is lost. |
| **Worker processes an event twice** | Idempotency ledger or unique index makes the second delivery a no-op. |
| **Two publishers run at once** | `SKIP LOCKED` gives them disjoint rows. |
| **Client retries a POST** | Idempotency key returns the original transaction with 200. |
| **An event type has no route** | The row is parked with an error and retried, never dropped. |
| **Cache invalidation fails** | Logged and swallowed. TTL bounds the staleness. |
| **Aggregate drifts from the transaction log** | The processor throws rather than clamping. The job lands in the failed set where it is visible. |

## Scaling

What changes at higher load, in the order it would actually be done:

| Pressure | First response | Later |
| --- | --- | --- |
| Slow history reads | Composite index + keyset pagination (both built) | Partitioning by time |
| Expensive analytics | Pre-aggregation + cache (both built) | A separate analytics store |
| API CPU | More API instances — they are stateless | — |
| Queue backlog | More worker instances — verified with `--scale worker=2` | Shard queues by type |
| Write contention | Row-level locking, already per-account | Shard by account |

The API and worker scale independently, which is the concrete reason they are separate
processes: if analytics jobs back up while request latency is fine, adding workers fixes
it without touching the API tier.

## Measured, not assumed

Numbers live in [`../load/results/`](../load/results/) with the query, dataset size,
hardware and method that produced each one. Nothing is claimed that was not run.
