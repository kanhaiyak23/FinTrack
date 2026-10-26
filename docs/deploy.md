# Deploying to Render

Deployed as a Render Blueprint (`render.yaml`): one web service (API **and** worker, started together) and one Key Value (Redis).
Postgres comes from Neon and MongoDB from MongoDB Atlas.

## One-time setup

1. **Neon**: create a project, then copy the connection string with the **pooler toggle off**
   (host without `-pooler`) and make sure it ends in `?sslmode=require`.
2. **Atlas**: create a free M0 cluster, a database user, and under Network Access allow
   `0.0.0.0/0` (Render free services have no fixed outbound IP). Copy the
   `mongodb+srv://...` connection string.
3. **Render**: push this repo to GitHub, then *New + > Blueprint* and select it.
4. When prompted, paste the Neon string as `DATABASE_URL` and the Atlas string as
   `MONGODB_URL`. `JWT_SECRET` and `REDIS_URL` are filled in automatically.
5. After the first deploy, open `https://<service>.onrender.com/docs` for Swagger UI.

Every deploy runs `prisma migrate deploy` in the build step, so schema changes ship with the code.

## Free-tier caveats

- The web service sleeps after ~15 min idle; the first request then takes ~30-60 s.
- Neon's free compute suspends after ~5 min idle and resumes in about a second, so the
  first query after a quiet spell is slightly slower. Data is kept (unlike Render's free Postgres).
- The worker runs inside the same service, so it sleeps with the API. Queued events are processed
  when the service wakes, and scheduled daily/monthly reports run late. See ADR-020.

## Demo flow in Swagger UI

`POST /auth/register` -> copy `token` -> **Authorize** -> `POST /accounts` -> `POST /transactions`
(DEPOSIT) -> `GET /transactions`, then a few seconds later `GET /analytics/portfolio`, `GET /activity`
(filled in by the worker).
