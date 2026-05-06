import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { connectMongo, disconnectMongo, activityEvents } from '../../apps/api/src/db/mongo.js';
import { disconnectRedis } from '../../apps/api/src/db/redis.js';
import { activityProcessor } from '../../apps/worker/src/processors/activity.js';
import {
  connectMongo as connectWorkerMongo,
  ensureIndexes,
  disconnectMongo as disconnectWorkerMongo,
} from '../../apps/worker/src/db/mongo.js';
import { disconnectPostgres as disconnectWorkerPostgres } from '../../apps/worker/src/db/prisma.js';
import { disconnectCacheRedis } from '../../apps/worker/src/db/redis.js';
import { resetDatabase } from '../helpers/db.js';
import { registerUser, createAccount, createPlan } from '../helpers/factories.js';

const app = createApp();

// Drives the activity processor over whatever the outbox holds, so a test asserts on a
// settled history rather than racing the publisher's poll interval.
const drainToActivity = async () => {
  const rows = await prisma.outboxEvent.findMany({ orderBy: { occurredAt: 'asc' } });
  for (const row of rows) {
    await activityProcessor({
      id: row.id,
      name: row.eventType,
      data: {
        eventId: row.id,
        eventType: row.eventType,
        entityType: row.entityType,
        entityId: row.entityId,
        userId: row.userId,
        payload: row.payload,
        occurredAt: row.occurredAt.toISOString(),
      },
    });
  }
  return rows;
};

beforeAll(async () => {
  await connectMongo();
  await connectWorkerMongo();
  await ensureIndexes();
});

beforeEach(async () => {
  await resetDatabase();
  await activityEvents().deleteMany({});
});

afterAll(async () => {
  await Promise.allSettled([
    disconnectPostgres(), disconnectWorkerPostgres(),
    disconnectMongo(), disconnectWorkerMongo(),
    disconnectRedis(), disconnectCacheRedis(),
  ]);
});

describe('event emission', () => {
  test('registering emits USER_REGISTERED in the same transaction', async () => {
    const { user } = await registerUser(app);

    const rows = await prisma.outboxEvent.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.eventType)).toEqual(['USER_REGISTERED']);
    expect(rows[0].publishedAt).toBeNull();
  });

  test('logging in emits LOGIN', async () => {
    const { credentials } = await registerUser(app);
    await request(app).post('/auth/login').send({
      email: credentials.email, password: credentials.password,
    });

    const types = (await prisma.outboxEvent.findMany()).map((r) => r.eventType);
    expect(types).toContain('LOGIN');
  });

  test('a failed login emits nothing', async () => {
    const { credentials } = await registerUser(app);
    await prisma.outboxEvent.deleteMany({});

    await request(app).post('/auth/login').send({ email: credentials.email, password: 'wrong' });

    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  test('plan and subscription lifecycle emits four events', async () => {
    const { auth } = await registerUser(app);
    await prisma.outboxEvent.deleteMany({});

    const plan = await createPlan(app, auth);
    await auth(request(app).patch(`/plans/${plan.id}`)).send({ status: 'PAUSED' });
    const sub = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });
    await auth(request(app).delete(`/subscriptions/${sub.body.subscription.id}`));

    const types = (await prisma.outboxEvent.findMany({ orderBy: { occurredAt: 'asc' } }))
      .map((r) => r.eventType);
    expect(types).toEqual([
      'PLAN_CREATED', 'PLAN_UPDATED', 'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_CANCELLED',
    ]);
  });

  test("a rejected write emits nothing - the event and the change share a transaction", async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await prisma.outboxEvent.deleteMany({});

    // Overdraft: rejected before anything is written.
    const res = await auth(request(app).post('/transactions'))
      .send({ type: 'WITHDRAWAL', accountId: account.id, amount: '1000' });

    expect(res.status).toBe(422);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  test("cancelling a subscription twice emits one event", async () => {
    const { auth } = await registerUser(app);
    const plan = await createPlan(app, auth);
    const sub = await auth(request(app).post('/subscriptions')).send({ planId: plan.id });
    await auth(request(app).delete(`/subscriptions/${sub.body.subscription.id}`));
    await auth(request(app).delete(`/subscriptions/${sub.body.subscription.id}`));

    const cancels = await prisma.outboxEvent.count({ where: { eventType: 'SUBSCRIPTION_CANCELLED' } });
    expect(cancels).toBe(1);
  });
});

describe('activity processor', () => {
  test('writes the event to MongoDB with its metadata', async () => {
    const { auth, user } = await registerUser(app);
    const account = await createAccount(app, auth);
    await auth(request(app).post('/transactions'))
      .send({ type: 'DEPOSIT', accountId: account.id, amount: '2500.50' });
    await drainToActivity();

    const docs = await activityEvents().find({ userId: user.id }).toArray();
    const deposit = docs.find((d) => d.eventType === 'DEPOSIT_COMPLETED');

    expect(deposit.metadata).toMatchObject({ type: 'DEPOSIT', amount: '2500.5' });
    expect(deposit.occurredAt).toBeInstanceOf(Date);
    expect(deposit.processedAt).toBeInstanceOf(Date);
  });

  test('a redelivered event does not appear twice in the history', async () => {
    const { user } = await registerUser(app);

    await drainToActivity();
    await drainToActivity();
    await drainToActivity();

    expect(await activityEvents().countDocuments({ userId: user.id })).toBe(1);
  });

  test('the second delivery reports that it recorded nothing', async () => {
    await registerUser(app);
    const [row] = await prisma.outboxEvent.findMany();
    const job = {
      id: row.id,
      name: row.eventType,
      data: {
        eventId: row.id, eventType: row.eventType, entityType: row.entityType,
        entityId: row.entityId, userId: row.userId, payload: row.payload,
        occurredAt: row.occurredAt.toISOString(),
      },
    };

    expect(await activityProcessor(job)).toMatchObject({ recorded: true });
    expect(await activityProcessor(job)).toMatchObject({ recorded: false });
  });

  test('heterogeneous metadata is stored as-is - the reason MongoDB is here', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await auth(request(app).post('/transactions'))
      .send({ type: 'DEPOSIT', accountId: account.id, amount: '10000' });
    await auth(request(app).post('/transactions'))
      .send({ type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '3', price: '150' });
    await createPlan(app, auth);
    await drainToActivity();

    const byType = Object.fromEntries(
      (await activityEvents().find({}).toArray()).map((d) => [d.eventType, d.metadata]),
    );

    // A trade carries symbol/quantity/price, a registration carries an email, a plan
    // carries a frequency. No relational table wants to be all three.
    expect(byType.TRADE_EXECUTED).toMatchObject({ symbol: 'INFY', quantity: '3', price: '150' });
    expect(byType.USER_REGISTERED).toHaveProperty('email');
    expect(byType.PLAN_CREATED).toMatchObject({ frequency: 'MONTHLY' });
  });
});

describe('GET /activity', () => {
  const seedHistory = async () => {
    const user = await registerUser(app);
    const account = await createAccount(app, user.auth);
    for (let i = 0; i < 4; i += 1) {
      await user.auth(request(app).post('/transactions'))
        .send({ type: 'DEPOSIT', accountId: account.id, amount: '100' });
    }
    await drainToActivity();
    return user;
  };

  test('returns the caller history newest first', async () => {
    const { auth } = await seedHistory();
    const res = await auth(request(app).get('/activity'));

    expect(res.status).toBe(200);
    // 4 deposits + 1 registration
    expect(res.body.events).toHaveLength(5);
    const times = res.body.events.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test('filters by event type', async () => {
    const { auth } = await seedHistory();
    const res = await auth(request(app).get('/activity').query({ eventType: 'DEPOSIT_COMPLETED' }));

    expect(res.body.events).toHaveLength(4);
    expect(res.body.events.every((e) => e.eventType === 'DEPOSIT_COMPLETED')).toBe(true);
  });

  test('paginates without duplicates or gaps', async () => {
    const { auth } = await seedHistory();

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const res = await auth(
        request(app).get('/activity').query({ limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...res.body.events.map((e) => e.eventId));
      cursor = res.body.pageInfo.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test('a date range excludes everything outside it', async () => {
    const { auth } = await seedHistory();
    const res = await auth(request(app).get('/activity').query({ to: '2020-01-01' }));
    expect(res.body.events).toHaveLength(0);
  });

  test("never returns another user's activity", async () => {
    const alice = await seedHistory();
    const bob = await registerUser(app);
    await drainToActivity();

    const res = await bob.auth(request(app).get('/activity'));
    expect(res.body.events.every((e) => e.eventType === 'USER_REGISTERED')).toBe(true);
    expect(res.body.events).toHaveLength(1);
    void alice;
  });

  test('rejects an unknown event type filter', async () => {
    const { auth } = await seedHistory();
    expect((await auth(request(app).get('/activity').query({ eventType: 'NONSENSE' }))).status).toBe(422);
  });

  test('requires authentication', async () => {
    expect((await request(app).get('/activity')).status).toBe(401);
  });
});
