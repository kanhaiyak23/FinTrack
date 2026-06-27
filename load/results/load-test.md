# Load test results

Measured on 2026-09-19. Every number here came from a run that is reproducible with the
scripts in `load/`. Nothing is extrapolated.

## Environment

| | |
| --- | --- |
| Stack | `docker compose --profile app up -d --scale api=3 --scale worker=2` |
| Topology | k6 → Nginx :8080 → 3 API instances → PostgreSQL 16, MongoDB 8, Redis 7 |
| Host | Apple Silicon, 8 GB RAM, Colima VM with 4 vCPU / 4 GB |
| Database | 500,018 seeded transactions across 200 accounts |
| Tool | k6 v2.2.0 |

**The load generator runs on the same machine as the stack.** It competes with the
services for the same four cores, so these figures are a floor, not a ceiling.

## Read-heavy — cached analytics

`k6 run load/read-heavy.js` · 20 VUs, ramped, 45s · `GET /analytics/portfolio` + `/pnl`

| Metric | Value |
| --- | --- |
| Requests | 231,717 |
| Throughput | **5,107 req/s** |
| Latency p50 | **2.72 ms** |
| Latency p95 | **6.46 ms** |
| Latency max | 299.26 ms |
| Failed | **0.000%** |
| Cache hit rate | **100.00%** |

**What this does and does not show.** The 100% hit rate is the point and the caveat: it
measures the cached path — Nginx, Express, a Redis `GET`, JSON out. It is *not* a
measurement of analytics computation, which is what the cache exists to avoid. The single
299 ms outlier is the first request of the run, which is the one cache miss.

It also uses one user, so every VU shares one cache key. A realistic mix of users would
lower the hit rate and raise the average.

## Write-heavy — deposits under lock contention

`k6 run load/write-heavy.js` · 10 VUs, ramped, 45s · `POST /transactions`

| Metric | Value |
| --- | --- |
| Requests | 16,388 |
| Throughput | **361 req/s** |
| Latency p50 | **9.09 ms** |
| Latency p95 | **94.22 ms** |
| Latency max | 368.18 ms |
| Failed | **0.000%** |

Every iteration is a real database transaction: `SELECT ... FOR UPDATE` on the account
row, an insert, a balance update and an outbox write, all committed together.

**All 10 VUs deposit into the same account on purpose.** Every request contends for one
row lock, so this is the worst case rather than a favourable one. The gap between p50 and
p95 is that contention — requests queue behind the lock holder. Spread across accounts the
figure would be higher and less interesting.

## Worker throughput

The write run produced **16,437 outbox rows**. After it finished, the backlog was
**0 unpublished** — two worker instances drained every row, with no double-processing
(the same property verified directly in workstream L).

## What these numbers are not

- Not a capacity claim. "5,107 req/s" is this hardware, this dataset, this request mix,
  with the load generator on the same box.
- Not a user count. Nothing here says how many users the system supports, and the
  architecture being scalable is not evidence that it scales.
- Not a cold-cache measurement. A realistic hit rate would be lower.
- Not durable under database growth: 500k rows fits comfortably in the page cache at this
  VM size. Behaviour at 50M rows is untested and would likely be different.

## Reproducing

```bash
docker compose --profile app up -d --scale api=3 --scale worker=2
npm run seed -- --users=200 --transactions=500000
k6 run load/smoke.js        # verify the stack is wired up
k6 run load/read-heavy.js
k6 run load/write-heavy.js
```
