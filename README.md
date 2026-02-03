# FinTrack

Transaction analytics and reporting platform. A modular-monolith REST API with separate
background workers, built to demonstrate transactional correctness, asynchronous
processing, caching and horizontal scaling.

**Status: in development.** Workstream A (foundation) complete. See
[`docs/progress.md`](docs/progress.md) for what is built and what is not.

## Stack

Node.js · Express · PostgreSQL · MongoDB · Redis · BullMQ · Prisma · Docker · Nginx

PostgreSQL is the source of truth. Redis is a cache and the queue backend. MongoDB holds
activity events and report snapshots. Reasoning for each is in
[`docs/decisions.md`](docs/decisions.md).

## Requirements

- Node.js 20+
- A container runtime. This project is developed against [Colima](https://github.com/abiosoft/colima):
  ```bash
  brew install colima docker docker-compose
  colima start --cpu 4 --memory 4 --disk 40
  ```

## Running it

```bash
npm install
cp .env.example .env
# set JWT_SECRET - at least 32 chars:  openssl rand -hex 32

docker compose up -d        # postgres, mongodb, redis
npx prisma migrate deploy   # apply migrations
npm run dev:api             # API on :4000
```

Check it:

```bash
curl -s http://localhost:4000/health | jq
```

Each subsystem is probed independently. Postgres being down returns 503, because nothing
can be served correctly without it. Redis or MongoDB being down still returns 200 — they
degrade rather than fail, which you can verify:

```bash
docker compose stop redis
curl -s http://localhost:4000/health | jq '.checks.redis'   # {"status": "down", ...}
docker compose start redis
```

## Tests

```bash
docker compose up -d
npm test
```

Integration tests run against real Postgres, MongoDB and Redis rather than mocks — the
behaviour worth testing here (transactions, idempotency, cache fallback) only exists
against the real thing.

## Documentation

| Document | Contents |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | Architecture, module boundaries, conventions, and ten invariants |
| [`docs/decisions.md`](docs/decisions.md) | Decision log with rejected alternatives |
| [`docs/progress.md`](docs/progress.md) | Workstream status and verified claims |

## Performance claims

There are none yet. Numbers appear in `load/results/` only once measured, each recorded
with its query, dataset size, hardware and method.
