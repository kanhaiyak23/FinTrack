import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { connectMongo, disconnectMongo } from '../../apps/api/src/db/mongo.js';
import { disconnectRedis } from '../../apps/api/src/db/redis.js';
import { resetDatabase } from '../helpers/db.js';
import { registerUser, createAccount, createPlan } from '../helpers/factories.js';

const app = createApp();

beforeAll(async () => {
  await connectMongo();
  await resetDatabase();
});

afterAll(async () => {
  await Promise.allSettled([disconnectPostgres(), disconnectMongo(), disconnectRedis()]);
});

describe('accounts', () => {
  test('creates an account with a zero balance', async () => {
    const { auth } = await registerUser(app);
    const res = await auth(request(app).post('/accounts')).send({ accountType: 'SAVINGS' });

    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ accountType: 'SAVINGS', currency: 'INR' });
    expect(res.body.account.balance).toBe('0.0000');
  });

  test('returns money as a string, never a JSON number', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    expect(typeof account.balance).toBe('string');
  });

  test('rejects an unknown account type with 422', async () => {
    const { auth } = await registerUser(app);
    const res = await auth(request(app).post('/accounts')).send({ accountType: 'CRYPTO' });
    expect(res.status).toBe(422);
  });

  test('lists only the accounts belonging to the caller', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await createAccount(app, alice.auth);
    await createAccount(app, alice.auth);
    await createAccount(app, bob.auth);

    const res = await alice.auth(request(app).get('/accounts'));
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
  });

  test("another user's account is indistinguishable from one that does not exist", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const aliceAccount = await createAccount(app, alice.auth);

    const foreign = await bob.auth(request(app).get(`/accounts/${aliceAccount.id}`));
    const missing = await bob.auth(
      request(app).get('/accounts/00000000-0000-0000-0000-000000000000'),
    );

    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/accounts');
    expect(res.status).toBe(401);
  });
});

describe('pagination', () => {
  test('walks every row exactly once with no duplicates or gaps', async () => {
    const { auth } = await registerUser(app);
    for (let i = 0; i < 7; i += 1) await createAccount(app, auth);

    const seen = [];
    let cursor;
    let pages = 0;

    do {
      const res = await auth(
        request(app).get('/accounts').query({ limit: 3, ...(cursor ? { cursor } : {}) }),
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.accounts.map((a) => a.id));
      cursor = res.body.pageInfo.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  test('a row inserted mid-scroll does not shift the following page', async () => {
    const { auth } = await registerUser(app);
    const original = [];
    for (let i = 0; i < 4; i += 1) original.push((await createAccount(app, auth)).id);

    const first = await auth(request(app).get('/accounts').query({ limit: 2 }));
    // OFFSET pagination would now repeat a row on page two; a keyset cursor cannot.
    await createAccount(app, auth);

    const second = await auth(
      request(app).get('/accounts').query({ limit: 2, cursor: first.body.pageInfo.nextCursor }),
    );

    const firstIds = first.body.accounts.map((a) => a.id);
    const secondIds = second.body.accounts.map((a) => a.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  test('rejects a malformed cursor with 400', async () => {
    const { auth } = await registerUser(app);
    const res = await auth(request(app).get('/accounts').query({ cursor: 'not-a-cursor' }));
    expect(res.status).toBe(400);
  });

  test('caps the page size', async () => {
    const { auth } = await registerUser(app);
    const res = await auth(request(app).get('/accounts').query({ limit: 5000 }));
    expect(res.status).toBe(422);
  });
});

describe('investment plans', () => {
  test('creates a plan and preserves decimal precision', async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth, { amount: '1234.5678' });
    expect(plan.amount).toBe('1234.5678');
  });

  test('rejects a zero amount at the database boundary', async () => {
    const { auth } = await registerUser(app);
    const res = await auth(request(app).post('/plans')).send({
      name: 'Zero', planType: 'SIP', amount: '0', frequency: 'MONTHLY', startDate: '2026-01-01',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('filters by status', async () => {
    const { auth } = await registerUser(app);
    const active = await createPlan(app, auth);
    const paused = await createPlan(app, auth);
    await auth(request(app).patch(`/plans/${paused.id}`)).send({ status: 'PAUSED' });

    const res = await auth(request(app).get('/plans').query({ status: 'ACTIVE' }));
    expect(res.body.plans.map((p) => p.id)).toEqual([active.id]);
  });

  test("cannot patch another user's plan", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const plan = await createPlan(app, alice.auth);

    const res = await bob.auth(request(app).patch(`/plans/${plan.id}`)).send({ status: 'CANCELLED' });
    expect(res.status).toBe(404);

    const stored = await prisma.investmentPlan.findUnique({ where: { id: plan.id } });
    expect(stored.status).toBe('ACTIVE');
  });

  test('rejects an empty patch body rather than silently doing nothing', async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth);
    const res = await auth(request(app).patch(`/plans/${plan.id}`)).send({});
    expect(res.status).toBe(422);
  });
});

describe('subscriptions', () => {
  test('subscribes to an owned plan', async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth);

    const res = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });
    expect(res.status).toBe(201);
    expect(res.body.subscription).toMatchObject({ planId: plan.id, status: 'ACTIVE' });
    expect(res.body.subscription.endedAt).toBeNull();
  });

  test("cannot subscribe to another user's plan", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const plan = await createPlan(app, alice.auth);

    const res = await bob.auth(request(app).post('/subscriptions')).send({ planId: plan.id });
    expect(res.status).toBe(404);
  });

  test('refuses a second active subscription to the same plan', async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth);

    await auth(request(app).post('/subscriptions')).send({ planId: plan.id });
    const second = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });

    expect(second.status).toBe(409);
  });

  test('allows resubscribing after cancellation', async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth);

    const first = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });
    await auth(request(app).delete(`/subscriptions/${first.body.subscription.id}`));
    const again = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });

    // The unique index is partial on status = 'ACTIVE', so history accumulates.
    expect(again.status).toBe(201);
  });

  test('cancelling sets an end date, and cancelling twice is a 404', async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth);
    const created = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });

    const cancelled = await auth(request(app).delete(`/subscriptions/${created.body.subscription.id}`));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.subscription.endedAt).not.toBeNull();

    const again = await auth(request(app).delete(`/subscriptions/${created.body.subscription.id}`));
    expect(again.status).toBe(404);
  });
});
