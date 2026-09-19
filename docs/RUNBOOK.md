# FinTrack — Run & Verify Guide

How to run this project from nothing, and how to prove each feature actually works rather
than assume it does. Every command here was run against this codebase; the outputs are
real.

Read [`architecture.md`](architecture.md) for *why* it is built this way. This document is
*how to operate it*.

An illustrated version of this guide, with diagrams and clickable navigation, is at
[`FinTrack-Guide.pdf`](FinTrack-Guide.pdf) (21 pages).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [First run](#2-first-run)
3. [Two ways to run it](#3-two-ways-to-run-it)
4. [Verify the basics](#4-verify-the-basics)
5. [Verify each feature](#5-verify-each-feature)
6. [Verify the hard guarantees](#6-verify-the-hard-guarantees)
7. [Inspect the databases directly](#7-inspect-the-databases-directly)
8. [Run the tests](#8-run-the-tests)
9. [Run the benchmarks](#9-run-the-benchmarks)
10. [Scale it](#10-scale-it)
11. [Troubleshooting](#11-troubleshooting)
12. [Shut down](#12-shut-down)

---

## 1. Prerequisites

| Need | Check | Install |
| --- | --- | --- |
| Node 20+ | `node -v` | `brew install node` |
| Container runtime | `docker info` | `brew install colima docker docker-compose` |
| k6 (only for §9) | `k6 version` | `brew install k6` |
| jq (used by every example here) | `jq --version` | `brew install jq` |

If Docker says "command not found" or "cannot connect", start the VM:

```bash
colima start --cpu 4 --memory 4 --disk 40
```

**One-time only:** Homebrew installs `docker-compose` as a standalone binary, so
`docker compose` (with a space) may not resolve. Link it as a CLI plugin:

```bash
mkdir -p ~/.docker/cli-plugins
ln -sfn $(brew --prefix)/opt/docker-compose/bin/docker-compose ~/.docker/cli-plugins/docker-compose
docker compose version      # should print a version
```

---

## 2. First run

```bash
cd ~/FinTrack
npm install
```

`npm 11` blocks package install scripts by default, and Prisma needs its postinstall to
download the query engine. If you see an `allow-scripts` warning:

```bash
npm approve-scripts prisma @prisma/engines @prisma/client
npm install
```

Create your environment file and a real secret:

```bash
cp .env.example .env
```

Then set `JWT_SECRET` inside `.env` to at least 32 characters:

```bash
openssl rand -hex 32          # paste the output into JWT_SECRET=
```

The app **refuses to start** without it, on purpose — a process running with a guessable
signing key is worse than one that will not boot.

Start the databases and apply the schema:

```bash
docker compose up -d          # postgres, mongodb, redis
docker compose ps             # wait until all three say (healthy)
npx prisma migrate deploy     # creates all tables, indexes and constraints
npx prisma generate           # builds the typed client
```

---

## 3. Two ways to run it

### A. Local processes — use this while developing

Two terminals:

```bash
npm run dev:api               # API on http://localhost:4000
```
```bash
npm run dev:worker            # background worker, no port
```

`--watch` restarts either on file change. **Both are needed**: the API accepts writes,
but nothing updates analytics, activity or reports until the worker runs.

### B. Full stack in containers — use this to demo

```bash
docker compose --profile app up -d --scale api=3 --scale worker=2
```

Everything behind Nginx on **http://localhost:8080**. Three API instances, two workers.
The API deliberately publishes no host port — the only way in is the load balancer.

Swap `localhost:4000` for `localhost:8080` in every command below when using this mode.

> **Do not run both modes at once**, and stop the containerised app before running tests.
> They share one Postgres and one Redis, so a containerised worker will consume jobs your
> local worker or your tests are waiting for:
> ```bash
> docker compose --profile app stop api worker nginx
> ```

---

## 4. Verify the basics

```bash
curl -s http://localhost:4000/health | jq
```

```json
{
  "status": "ok",
  "instance": "api-local",
  "uptimeSeconds": 1,
  "checks": {
    "postgres": { "status": "up", "latencyMs": 1.28 },
    "mongodb":  { "status": "up", "latencyMs": 1.24 },
    "redis":    { "status": "up", "latencyMs": 0.89 }
  }
}
```

Each subsystem is probed **independently**. Postgres down → `503`. Redis or MongoDB down →
still `200`, with that subsystem marked `down`, because they degrade rather than fail.
That asymmetry is the design, not an oversight — see §6.3.

---

## 5. Verify each feature

Set up a shell session. Every later block reuses `$TOKEN` and `$ACC`.

```bash
API=http://localhost:4000

TOKEN=$(curl -s -X POST $API/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@fintrack.dev","name":"Demo User","password":"correct-horse-battery"}' \
  | jq -r .token)

ACC=$(curl -s -X POST $API/accounts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountType":"BROKERAGE"}' | jq -r .account.id)

echo "token: ${TOKEN:0:20}…   account: $ACC"
```

### 5.1 Authentication

```bash
curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@fintrack.dev","password":"correct-horse-battery"}' | jq .user
```

**Check the token carries nothing but identity:**

```bash
python3 -c "import base64,json,sys;p=sys.argv[1].split('.')[1];p+='='*(-len(p)%4);print(json.dumps(json.loads(base64.urlsafe_b64decode(p)),indent=2))" "$TOKEN"
```

```json
{
  "iat": 1789804364,
  "exp": 1789807964,
  "iss": "fintrack",
  "sub": "2ced0658-cedf-4fa2-aa9a-e31a241b4658"
}
```

(Piping straight into `base64 -d` fails on macOS: a JWT uses base64**url** with the
padding stripped, and the system `base64` rejects it. Hence the Python one-liner.)

No email, no name, no role. A JWT is signed, not encrypted — anything inside it is
readable by whoever holds it.

**Check it cannot be used to discover accounts:**

```bash
curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@fintrack.dev","password":"wrong"}'
curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"nobody@fintrack.dev","password":"wrong"}'
```

Both return the identical body:

```json
{"error":{"message":"Invalid email or password","requestId":"…"}}
```

Same status, same message. The server also runs a dummy bcrypt comparison when no user is
found, so the two paths take comparable time — an identical message with a measurably
faster "unknown email" response would leak the same information through timing.

### 5.2 Money movement

```bash
post() { curl -s -X POST $API/transactions -H "Authorization: Bearer $TOKEN" \
         -H 'Content-Type: application/json' -d "$1"; }

post '{"type":"DEPOSIT","accountId":"'$ACC'","amount":"100000"}'                               | jq .transaction.amount
post '{"type":"BUY","accountId":"'$ACC'","symbol":"INFY","quantity":"10","price":"100"}'       | jq .transaction.amount
post '{"type":"BUY","accountId":"'$ACC'","symbol":"INFY","quantity":"10","price":"200"}'       | jq .transaction.amount
post '{"type":"SELL","accountId":"'$ACC'","symbol":"INFY","quantity":"5","price":"250"}'       | jq .transaction.amount
```

Note the BUY amounts come back as `1000.0000` and `2000.0000` — **computed server-side**
as quantity × price. Sending your own `amount` on a trade is rejected; otherwise a client
could set its own price.

**Money is always a string, never a JSON number:**

```bash
curl -s $API/accounts -H "Authorization: Bearer $TOKEN" | jq '.accounts[0].balance'
# "98250.0000"   ← quoted
```

JSON numbers are IEEE-754 doubles. A client parsing `12345678.91` can silently get
something else, so every monetary value crosses the wire as a decimal string.

**Overdraft is refused:**

```bash
post '{"type":"WITHDRAWAL","accountId":"'$ACC'","amount":"9999999"}' | jq
```

```json
{
  "error": {
    "message": "Insufficient funds",
    "details": ["available 98250.0000, required 9999999.0000"],
    "requestId": "…"
  }
}
```

**Short selling is refused:**

```bash
post '{"type":"SELL","accountId":"'$ACC'","symbol":"TCS","quantity":"1","price":"100"}' | jq .error
# "Insufficient holdings"  ·  "TCS: holding 0.00000000, attempted to sell 1.00000000"
```

**A deposit carrying trade fields is refused** — not silently ignored:

```bash
post '{"type":"DEPOSIT","accountId":"'$ACC'","amount":"10","symbol":"INFY","quantity":"1","price":"1"}' | jq .error.message
# "Validation failed"
```

An unexpected field on a money movement means the client believes it is doing something
the server is not about to do.

### 5.3 Reading transactions

```bash
curl -s "$API/transactions?limit=2" -H "Authorization: Bearer $TOKEN" | jq '.transactions[].type, .pageInfo'
```

Pagination is **keyset**, not offset. Take `pageInfo.nextCursor` and pass it back:

```bash
CURSOR=$(curl -s "$API/transactions?limit=2" -H "Authorization: Bearer $TOKEN" | jq -r .pageInfo.nextCursor)
curl -s "$API/transactions?limit=2&cursor=$CURSOR" -H "Authorization: Bearer $TOKEN" | jq '.transactions[].id'
```

Filters: `accountId`, `type`, `symbol`, `from`, `to`.

### 5.4 Plans and subscriptions

```bash
PLAN=$(curl -s -X POST $API/plans -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Monthly SIP","planType":"SIP","amount":"5000","frequency":"MONTHLY","startDate":"2026-01-01"}' \
  | jq -r .plan.id)

curl -s -X POST $API/subscriptions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"planId":"'$PLAN'"}' | jq '.subscription.status, .subscription.endedAt'
# "ACTIVE"  ·  null
```

**Subscribing twice is a conflict**, enforced by a partial unique index rather than a
check-then-insert (which would race):

```bash
curl -s -X POST $API/subscriptions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"planId":"'$PLAN'"}' | jq .error.message
# "Already subscribed to this plan"
```

### 5.5 Analytics

Wait a couple of seconds after writing transactions — the worker updates these
asynchronously.

```bash
curl -s $API/analytics/portfolio -H "Authorization: Bearer $TOKEN" | jq
```

```json
{
  "cash": { "total": "98750.0000", "accounts": 1 },
  "holdings": [{
    "symbol": "INFY",
    "quantity": "15.00000000",
    "averageBuyPrice": "150.0000",
    "costBasis": "2250.0000",
    "realizedPnl": "500.0000"
  }],
  "totals": { "symbols": 1, "costBasis": "2250.0000", "marketValue": null, "unrealizedPnl": null }
}
```

**Check the arithmetic yourself** — this is the number to be able to defend:

- Bought 10 @ 100 and 10 @ 200 → 20 units costing 3,000 → average **150**
- Sold 5 @ 250 → realised `(250 − 150) × 5` = **500**
- Left with 15 units at a basis of `3000 − (5 × 150)` = **2,250**

`marketValue` and `unrealizedPnl` are `null` on purpose. There is no price feed, and a
number derived from cost basis would look like a valuation without being one.

```bash
curl -s $API/analytics/pnl -H "Authorization: Bearer $TOKEN" | jq
curl -s $API/analytics/activity -H "Authorization: Bearer $TOKEN" | jq .totals
```

The P&L response states `"method": "WEIGHTED_AVERAGE"` so a consumer never has to guess
which cost-basis rule produced it.

### 5.6 Activity history

```bash
curl -s "$API/activity?limit=10" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.events[] | "\(.eventType)  \(.entityType)"'
```

```
TRADE_EXECUTED       transaction
TRADE_EXECUTED       transaction
DEPOSIT_COMPLETED    transaction
LOGIN                user
USER_REGISTERED      user
```

This comes from **MongoDB**, not Postgres. Look at why:

```bash
curl -s "$API/activity?limit=20" -H "Authorization: Bearer $TOKEN" \
  | jq '.events[] | {type: .eventType, metadata}' | head -30
```

A trade carries `symbol`, `quantity`, `price`. A registration carries an `email`. A plan
carries a `frequency`. One relational table holding all of those would be mostly NULL
columns — that is the concrete reason MongoDB is in this project, and the answer to
"why not just use Postgres JSONB?" is that this collection needs no joins and no
transactions.

Filter it:

```bash
curl -s "$API/activity?eventType=DEPOSIT_COMPLETED" -H "Authorization: Bearer $TOKEN" | jq '.events | length'
```

### 5.7 Reports

```bash
TODAY=$(date +%F)
curl -s -i "$API/reports/daily?date=$TODAY" -H "Authorization: Bearer $TOKEN" \
  | grep -iE '^HTTP|retry-after'
```

The first call returns **202 Accepted**, not 404:

```
HTTP/1.1 202 Accepted
retry-after: 10
```

The report does not exist yet — and asking for it *queued its generation*. That is the
async boundary made visible. Ask again a few seconds later:

```bash
sleep 5
curl -s "$API/reports/daily?date=$TODAY" -H "Authorization: Bearer $TOKEN" | jq .report.metrics
```

```json
{
  "transactionCount": 7,
  "tradingVolume": "4250.0000",
  "deposits": "100600.0000",
  "withdrawals": "60.0000",
  "buyValue": "3000.0000",
  "sellValue": "1250.0000",
  "realizedPnl": "500.0000",
  "activeInvestmentPlans": 0,
  "activityEvents": 8,
  "activeDays": 1,
  "openPositions": 1,
  "timezone": "Asia/Kolkata"
}
```

Your figures will differ — they reflect whatever you posted above. What matters is that
they are computed from the aggregates rather than by scanning the transaction table, and
that `timezone` states which day boundary was used.

Reports also generate on a schedule: daily at 00:15 and monthly at 00:30 on the 1st, in
`REPORT_TIMEZONE`. 00:15 rather than midnight so the worker has drained events from the
last minutes of the day.

---

## 6. Verify the hard guarantees

These are the properties worth demonstrating in an interview. Each is observable.

### 6.1 A retry does not create a second transaction

```bash
KEY="demo-$(date +%s)"
curl -s -o /dev/null -w 'first:  %{http_code}\n' -X POST $API/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d '{"type":"DEPOSIT","accountId":"'$ACC'","amount":"500"}'

curl -s -o /dev/null -w 'second: %{http_code}\n' -X POST $API/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d '{"type":"DEPOSIT","accountId":"'$ACC'","amount":"500"}'
```

```
first:  201
second: 200
```

**200, not 201** — 201 would claim a second transaction was created, which is exactly what
idempotency prevented. The body is the original transaction, with `"replayed": true`.

Now prove it under concurrency:

```bash
KEY="race-$(date +%s)"
for i in 1 2 3 4 5; do
  curl -s -X POST $API/transactions -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
    -d '{"type":"DEPOSIT","accountId":"'$ACC'","amount":"250"}' | jq -r .transaction.id &
done; wait
```

Five identical ids. One transaction, one balance movement.

### 6.2 Concurrent withdrawals cannot both succeed

```bash
ACC2=$(curl -s -X POST $API/accounts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountType":"SAVINGS"}' | jq -r .account.id)
curl -s -o /dev/null -X POST $API/transactions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"DEPOSIT","accountId":"'$ACC2'","amount":"100"}'

for i in 1 2; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/transactions -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"type":"WITHDRAWAL","accountId":"'$ACC2'","amount":"60"}' &
done; wait

curl -s $API/accounts -H "Authorization: Bearer $TOKEN" | jq -r '.accounts[] | select(.id=="'$ACC2'") | .balance'
```

One `201`, one `422`, balance `40.0000`. Without the `SELECT … FOR UPDATE` both requests
would read 100, both conclude 60 is affordable, and the account would land at −20.

### 6.3 Redis failing costs latency, not correctness

```bash
curl -s -D - -o /dev/null $API/analytics/portfolio -H "Authorization: Bearer $TOKEN" | grep -i x-cache
curl -s -D - -o /dev/null $API/analytics/portfolio -H "Authorization: Bearer $TOKEN" | grep -i x-cache
# x-cache: MISS
# x-cache: HIT

docker compose stop redis

curl -s -o /dev/null -w 'status: %{http_code}\n' $API/analytics/portfolio -H "Authorization: Bearer $TOKEN"
curl -s $API/analytics/portfolio -H "Authorization: Bearer $TOKEN" | jq .holdings[0].quantity
curl -s $API/health | jq '.status, .checks.redis.status'

docker compose start redis
```

With Redis stopped: **still `200`**, same correct figures, `x-cache: MISS`, and `/health`
reports `"ok"` overall with `redis: "down"`. The cache is an optimisation; Postgres is the
source of truth.

### 6.4 An event is never lost between the commit and the queue

Stop the worker, write a transaction, and watch the event wait durably in Postgres:

```bash
# stop only the worker (Ctrl-C in its terminal, or):
docker compose --profile app stop worker 2>/dev/null

curl -s -o /dev/null -X POST $API/transactions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"DEPOSIT","accountId":"'$ACC'","amount":"77"}'

docker compose exec -T postgres psql -U fintrack -d fintrack -c \
  "SELECT event_type, published_at FROM outbox_events WHERE published_at IS NULL;"
```

The row sits there with `published_at` NULL. Start the worker again and it drains:

```bash
npm run dev:worker     # or: docker compose --profile app start worker
sleep 3
docker compose exec -T postgres psql -U fintrack -d fintrack -c \
  "SELECT count(*) AS unpublished FROM outbox_events WHERE published_at IS NULL;"
# 0
```

The event and the balance change were written in **one transaction**, so there is no
window in which the money moved but the event vanished.

### 6.5 Processing the same event twice changes nothing twice

```bash
docker compose exec -T postgres psql -U fintrack -d fintrack -c \
  "SELECT processor, count(*) FROM processed_events GROUP BY processor;"
```

Every event a worker applies is claimed in `processed_events` **in the same transaction as
the aggregate change**. A redelivery finds its own claim and does nothing. The activity
processor uses a different guard — a unique index on `eventId` in MongoDB — because its
write and a Postgres ledger entry cannot share a transaction (ADR-018).

### 6.6 Aggregates are order-independent

This one had a real bug (ADR-019). Fire three trades as fast as possible so the worker
processes them concurrently:

```bash
ACC3=$(curl -s -X POST $API/accounts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountType":"BROKERAGE"}' | jq -r .account.id)
curl -s -o /dev/null -X POST $API/transactions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"DEPOSIT","accountId":"'$ACC3'","amount":"100000"}'

for t in '{"type":"BUY","accountId":"'$ACC3'","symbol":"WIPRO","quantity":"10","price":"100"}' \
         '{"type":"BUY","accountId":"'$ACC3'","symbol":"WIPRO","quantity":"10","price":"200"}' \
         '{"type":"SELL","accountId":"'$ACC3'","symbol":"WIPRO","quantity":"5","price":"250"}'; do
  curl -s -o /dev/null -X POST $API/transactions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$t"
done
sleep 4

curl -s $API/analytics/portfolio -H "Authorization: Bearer $TOKEN" \
  | jq '.holdings[] | select(.symbol=="WIPRO") | {quantity, averageBuyPrice, costBasis, realizedPnl}'
```

Must be `15.00000000`, `150.0000`, `2250.0000`, `500.0000` **every time**. If you see
`2500` and `750`, the sale was applied before the second purchase — that is the bug ADR-019
fixed by recomputing the holding from the transaction log instead of mutating it
incrementally.

---

## 7. Inspect the databases directly

### PostgreSQL

```bash
docker compose exec -it postgres psql -U fintrack -d fintrack
```

```sql
\dt                     -- tables
\di                     -- indexes
\d transactions         -- one table in full, constraints included

-- business rules the DATABASE enforces, not the application
SELECT conrelid::regclass AS table, conname
FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
ORDER BY 1;

-- the outbox: is anything stuck?
SELECT event_type, count(*), count(*) FILTER (WHERE published_at IS NULL) AS unpublished
FROM outbox_events GROUP BY 1;

-- rows that keep failing to publish
SELECT id, event_type, attempts, last_error FROM outbox_events
WHERE published_at IS NULL AND attempts > 0;

-- the pre-aggregated state the analytics endpoints read
SELECT * FROM portfolio_holdings;
SELECT * FROM daily_user_aggregates ORDER BY day DESC LIMIT 5;
```

Try to break a constraint by hand — it should refuse:

```sql
UPDATE accounts SET balance = -1 WHERE id = (SELECT id FROM accounts LIMIT 1);
-- ERROR: chk_accounts_balance_non_negative

INSERT INTO transactions (id, account_id, type, amount)
VALUES (gen_random_uuid(), (SELECT id FROM accounts LIMIT 1), 'BUY', 100);
-- ERROR: chk_transactions_trade_fields   (a BUY with no symbol)
```

### MongoDB

```bash
docker compose exec -it mongodb mongosh fintrack
```

```javascript
db.activity_events.countDocuments({})
db.activity_events.find().sort({occurredAt:-1}).limit(5).pretty()
db.activity_events.getIndexes()        // user_time, user_type_time, event_id_unique
db.report_snapshots.find().pretty()
```

### Redis

```bash
docker compose exec -it redis redis-cli
```

```
KEYS analytics:*            # cached analytics per user
TTL analytics:user:<id>:portfolio
KEYS bull:*                 # BullMQ queue state
LLEN bull:analytics:wait    # queue depth — a growing number means workers cannot keep up
```

---

## 8. Run the tests

```bash
docker compose up -d
docker compose --profile app stop api worker nginx    # if the full stack is running
npm test
```

```
Test Suites: 11 passed, 11 total
Tests:       153 passed, 153 total
Time:        ~50 s
```

One suite at a time:

```bash
npm test -- tests/integration/transactions.test.js
npm test -- tests/integration/workers.test.js
npm test -- --testNamePattern='idempot'
```

These run against **real** PostgreSQL, MongoDB and Redis. Mocks cannot demonstrate row
locking, transaction rollback or cache fallback — the behaviour only exists against the
real thing. They run serially because several suites truncate a shared database.

---

## 9. Run the benchmarks

### Index benchmark

```bash
npm run seed -- --users=200 --transactions=500000      # ~30 s
docker compose exec -T postgres psql -U fintrack -d fintrack -f db/benchmark/explain.sql
```

Compare the two plans. Recorded result: **0.153 ms with the index, 38.078 ms without** —
and the interesting part is that the slow plan is *not* a sequential scan. Postgres falls
back to the idempotency index, finds the rows, then has to read 2,665 of them from the
heap and sort to return 20.

The index is dropped inside a transaction that is rolled back, so a failed run cannot
leave it missing.

### Load tests

```bash
docker compose --profile app up -d --scale api=3 --scale worker=2
k6 run load/smoke.js          # is the stack wired up?
k6 run load/read-heavy.js     # cached analytics
k6 run load/write-heavy.js    # deposits under lock contention
```

Recorded results and their caveats: [`../load/results/`](../load/results/). The numbers are
a floor, not a ceiling — the load generator shares four cores with the stack.

---

## 10. Scale it

```bash
docker compose --profile app up -d --scale api=3 --scale worker=2
```

**Prove requests actually distribute:**

```bash
for i in $(seq 1 30); do
  curl -s -D - -o /dev/null http://localhost:8080/health | grep -i '^x-instance-id'
done | sort | uniq -c
```

```
  10 x-instance-id: api-bfa969b0a202
  10 x-instance-id: api-d8b2ad8002a8
  10 x-instance-id: api-ebcbc4688633
```

**Prove the API is stateless** — a token issued by one instance works on all of them:

```bash
T=$(curl -s -X POST http://localhost:8080/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"scale-'$(date +%s)'@x.dev","name":"S","password":"correct-horse-battery"}' | jq -r .token)

for i in $(seq 1 6); do
  curl -s -D - -o /dev/null http://localhost:8080/users/me -H "Authorization: Bearer $T" \
    | grep -iE '^(HTTP/|x-instance-id)' | tr -d '\r' | paste -sd' ' -
done
```

Every one returns `200` regardless of which instance answered. Nothing session-related is
held in process memory.

**Prove two workers do not double-process:**

```bash
docker compose exec -T postgres psql -U fintrack -d fintrack -c \
  "SELECT count(*) AS outbox FROM outbox_events;
   SELECT processor, count(*) FROM processed_events GROUP BY 1;"
```

Each event appears once per processor, never twice — the publisher claims rows with
`FOR UPDATE SKIP LOCKED`, so two publishers take disjoint sets.

Scale the workers alone when the queue backs up but request latency is fine:

```bash
docker compose --profile app up -d --scale worker=4
```

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `JWT_SECRET must be at least 32 characters` | `.env` missing or unset | `openssl rand -hex 32`, paste into `.env` |
| `@prisma/client did not initialize` | Client not generated | `npx prisma generate` |
| `allow-scripts` warning, Prisma fails | npm 11 blocks install scripts | `npm approve-scripts prisma @prisma/engines @prisma/client && npm install` |
| `docker: unknown command: compose` | Homebrew compose not linked as a plugin | see the symlink in §1 |
| `Cannot connect to the Docker daemon` | Colima not running | `colima start --cpu 4 --memory 4 --disk 40` |
| Analytics stay empty | Worker not running | `npm run dev:worker` |
| Analytics stale by a few seconds | Normal — they are eventually consistent | wait, or check the worker log |
| Tests fail with odd queue counts | Containerised worker is eating the jobs | `docker compose --profile app stop api worker nginx` |
| `unpublished` count keeps growing | Worker down, or Redis unreachable | check the worker log and `docker compose ps` |
| Port 4000 or 8080 in use | An earlier run is still alive | `lsof -ti:4000 \| xargs kill` |
| `nginx: host not found in upstream "api"` | Nginx started with no API replicas | bring up with `--profile app` and at least one `api` |

**Start over with clean data** (destroys everything in the databases):

```bash
docker compose down -v          # -v removes the volumes
docker compose up -d
npx prisma migrate deploy
```

**Read the logs:**

```bash
docker compose logs -f worker
docker compose logs -f api
docker compose logs -f nginx
```

---

## 12. Shut down

```bash
# local processes: Ctrl-C in each terminal, then
docker compose down                    # keeps data in volumes
docker compose --profile app down      # also stops api/worker/nginx
docker compose down -v                 # deletes data too
colima stop                            # stop the VM entirely
```

---

## The 90-second demo

If you have to show this quickly:

```bash
docker compose --profile app up -d --scale api=3 --scale worker=2
API=http://localhost:8080
TOKEN=$(curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"demo-'$(date +%s)'@x.dev","name":"Demo","password":"correct-horse-battery"}' | jq -r .token)
ACC=$(curl -s -X POST $API/accounts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountType":"BROKERAGE"}' | jq -r .account.id)
```

1. `curl -s $API/health | jq` — three subsystems, probed independently
2. Deposit, buy twice, sell once — the write path, each a real database transaction
3. `curl -s $API/analytics/portfolio -H "Authorization: Bearer $TOKEN" | jq` — updated by a
   worker, not by the request
4. Run it twice and show `x-cache` going `MISS` → `HIT`
5. `docker compose stop redis`, run it again — still correct, still `200`
6. `curl -s $API/activity -H "Authorization: Bearer $TOKEN" | jq` — the same events, from
   MongoDB, with per-type metadata
7. The 30-request loop from §10 — three instances sharing the load

Then say the thing that matters: *the API never waits for the worker, and the worker can
be restarted, duplicated or crashed without losing an event or double-counting one.*
