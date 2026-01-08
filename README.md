# FinTrack

A personal finance tracking API. Register a user, create accounts, record income and
expenses against them, and pull spending summaries broken down by category.

Built with Node.js and Express. Data lives in an in-memory store, so it resets on
restart — swapping in a real database means reimplementing `src/models/store.js`
and nothing else.

## Requirements

- Node.js 20 or newer

## Getting started

```bash
npm install
cp .env.example .env     # then set JWT_SECRET
npm run dev              # or: npm start
```

The API starts on `http://localhost:3000`. Check it with:

```bash
curl http://localhost:3000/health
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Port the server binds to |
| `NODE_ENV` | `development` | `production` makes `JWT_SECRET` mandatory |
| `JWT_SECRET` | dev-only fallback | Generate with `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | `7d` | Any [ms](https://github.com/vercel/ms) duration |

## API

All `/api/accounts` and `/api/transactions` routes require an
`Authorization: Bearer <token>` header. Tokens come from register or login.

### Auth

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `email`, `name`, `password` (min 8 chars) |
| `POST` | `/api/auth/login` | `email`, `password` |
| `GET` | `/api/auth/me` | — |

### Accounts

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/accounts` | Each account includes a computed `balance` |
| `POST` | `/api/accounts` | `name`, `type`, optional `currency`, `openingBalance` |
| `GET` | `/api/accounts/:id` | |
| `DELETE` | `/api/accounts/:id` | Also deletes the account's transactions |

`type` is one of `checking`, `savings`, `credit`, `cash`, `investment`.

### Transactions

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/transactions` | Filters: `accountId`, `category`, `from`, `to` |
| `POST` | `/api/transactions` | `accountId`, `amount`, `type`, `category`, optional `note`, `occurredAt` |
| `GET` | `/api/transactions/summary` | Totals and per-category breakdown; accepts `from`, `to` |
| `GET` | `/api/transactions/:id` | |
| `DELETE` | `/api/transactions/:id` | |

`type` is `income` or `expense`. Amounts are always positive — the type decides the sign.

## Example

```bash
# Register and capture the token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","name":"Me","password":"supersecret"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# Create an account
ACCOUNT=$(curl -s -X POST http://localhost:3000/api/accounts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Everyday","type":"checking","openingBalance":5000}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["account"]["id"])')

# Record an expense
curl -s -X POST http://localhost:3000/api/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"accountId\":\"$ACCOUNT\",\"amount\":250.50,\"type\":\"expense\",\"category\":\"groceries\"}"

# See where the money went
curl -s http://localhost:3000/api/transactions/summary -H "Authorization: Bearer $TOKEN"
```

## Project layout

```
src/
├── routes/       auth, accounts, transactions
├── models/       store.js — in-memory data layer
├── middleware/   auth, validation, error handling
├── app.js        wires routers and middleware together
└── server.js     entrypoint
```

## Notes and next steps

- The store is in-memory; nothing survives a restart. A real database is the first
  thing to add for any serious use.
- There is no rate limiting on the auth routes yet.
- Transactions can be created and deleted but not edited.

## License

MIT
