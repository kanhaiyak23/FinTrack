import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { connectMongo, disconnectMongo, reportSnapshots } from '../../apps/api/src/db/mongo.js';
import { redis, disconnectRedis } from '../../apps/api/src/db/redis.js';
import { closeQueues as closeApiQueues } from '../../apps/api/src/queues/index.js';
import { closeQueueConnection as closeApiQueueConnection } from '../../apps/api/src/queues/connection.js';
import { reportProcessor } from '../../apps/worker/src/processors/report.js';
import { analyticsProcessor } from '../../apps/worker/src/processors/analytics.js';
import { EVENT_ROUTES, QUEUE_NAMES } from '../../apps/worker/src/queues/routes.js';
import { JOB_NAMES } from '../../apps/worker/src/queues/jobs.js';
import { connectMongo as connectWorkerMongo, ensureIndexes, disconnectMongo as disconnectWorkerMongo } from '../../apps/worker/src/db/mongo.js';
import { disconnectPostgres as disconnectWorkerPostgres } from '../../apps/worker/src/db/prisma.js';
import { disconnectCacheRedis } from '../../apps/worker/src/db/redis.js';
import { closeQueues as closeWorkerQueues } from '../../apps/worker/src/queues/index.js';
import { closeQueueConnection as closeWorkerQueueConnection } from '../../apps/worker/src/queues/connection.js';
import { resetDatabase } from '../helpers/db.js';
import { registerUser, createAccount } from '../helpers/factories.js';

const app = createApp();
const TODAY = new Date().toISOString().slice(0, 10);

const drainAnalytics = async () => {
  const rows = await prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' } });
  for (const row of rows) {
    if ((EVENT_ROUTES[row.eventType] ?? []).includes(QUEUE_NAMES.ANALYTICS)) {
      await analyticsProcessor({
        id: row.id,
        name: row.eventType,
        data: {
          eventId: row.id, eventType: row.eventType, entityType: row.entityType,
          entityId: row.entityId, userId: row.userId, payload: row.payload,
        },
      });
    }
    await prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
  }
};

const generate = (userId, reportType = 'DAILY', periodStart = TODAY, periodEnd = TODAY) =>
  reportProcessor({ name: JOB_NAMES.GENERATE_REPORT, data: { userId, reportType, periodStart, periodEnd } });

const seededUser = async () => {
  const user = await registerUser(app);
  const account = await createAccount(app, user.auth);
  const post = (body) => user.auth(request(app).post('/transactions')).send(body);
  await post({ type: 'DEPOSIT', accountId: account.id, amount: '50000' });
  await post({ type: 'WITHDRAWAL', accountId: account.id, amount: '2000' });
  await post({ type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '10', price: '100' });
  await post({ type: 'SELL', accountId: account.id, symbol: 'INFY', quantity: '5', price: '150' });
  await drainAnalytics();
  return { ...user, account };
};

beforeAll(async () => {
  await connectMongo();
  await connectWorkerMongo();
  await ensureIndexes();
});

beforeEach(async () => {
  await resetDatabase();
  await reportSnapshots().deleteMany({});
  await redis.flushdb().catch(() => {});
});

afterAll(async () => {
  await Promise.allSettled([closeApiQueues(), closeWorkerQueues()]);
  await Promise.allSettled([
    disconnectPostgres(), disconnectWorkerPostgres(),
    disconnectMongo(), disconnectWorkerMongo(),
    disconnectRedis(), disconnectCacheRedis(),
    closeApiQueueConnection(), closeWorkerQueueConnection(),
  ]);
});

describe('report generation', () => {
  test('computes the metric set from the aggregates', async () => {
    const { user } = await seededUser();
    const { metrics } = await generate(user.id);

    expect(metrics).toMatchObject({
      transactionCount: 4,
      deposits: '50000.0000',
      withdrawals: '2000.0000',
      buyValue: '1000.0000',
      sellValue: '750.0000',
      tradingVolume: '1750.0000',
      realizedPnl: '250.0000',
      openPositions: 1,
      activeDays: 1,
    });
    expect(metrics.timezone).toBe('Asia/Kolkata');
  });

  test('regenerating upserts rather than duplicating', async () => {
    const { user } = await seededUser();

    await generate(user.id);
    await generate(user.id);
    await generate(user.id);

    const docs = await reportSnapshots().find({ userId: user.id }).toArray();
    expect(docs).toHaveLength(1);
  });

  test('regenerating produces the same figures - a report is derived, not accumulated', async () => {
    const { user } = await seededUser();

    const first = await generate(user.id);
    const second = await generate(user.id);

    expect(second.metrics).toEqual(first.metrics);
  });

  test('a monthly report spans the whole month', async () => {
    const { user } = await seededUser();
    const month = TODAY.slice(0, 7);

    const { metrics } = await generate(user.id, 'MONTHLY', `${month}-01`, `${month}-28`);
    expect(metrics.transactionCount).toBe(4);

    const doc = await reportSnapshots().findOne({ userId: user.id, reportType: 'MONTHLY' });
    expect(doc.periodStart).toBe(`${month}-01`);
  });

  test('daily and monthly reports for the same user coexist', async () => {
    const { user } = await seededUser();
    await generate(user.id, 'DAILY');
    await generate(user.id, 'MONTHLY', `${TODAY.slice(0, 7)}-01`, `${TODAY.slice(0, 7)}-28`);

    expect(await reportSnapshots().countDocuments({ userId: user.id })).toBe(2);
  });

  test('the scheduler fans out one job per active user, skipping dormant ones', async () => {
    const active = await seededUser();
    const dormant = await registerUser(app);
    await drainAnalytics();

    const { scheduled } = await reportProcessor({
      name: JOB_NAMES.SCHEDULE_REPORTS,
      data: { reportType: 'DAILY', anchor: TODAY },
    });

    // The dormant user has no aggregate row for the period, so no report is queued.
    expect(scheduled).toBe(1);
    void active; void dormant;
  });
});

describe('GET /reports', () => {
  test('returns 202 while a report does not exist yet', async () => {
    const { auth } = await seededUser();
    const res = await auth(request(app).get('/reports/daily').query({ date: TODAY }));

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.headers['retry-after']).toBe('10');
  });

  test('returns the snapshot once generated', async () => {
    const { auth, user } = await seededUser();
    await generate(user.id);

    const res = await auth(request(app).get('/reports/daily').query({ date: TODAY }));

    expect(res.status).toBe(200);
    expect(res.body.report.metrics.deposits).toBe('50000.0000');
    expect(res.body.report.reportType).toBe('DAILY');
  });

  test('a second read is served from cache', async () => {
    const { auth, user } = await seededUser();
    await generate(user.id);

    const first = await auth(request(app).get('/reports/daily').query({ date: TODAY }));
    const second = await auth(request(app).get('/reports/daily').query({ date: TODAY }));

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
  });

  test('regenerating invalidates the cached copy', async () => {
    const { auth, user } = await seededUser();
    await generate(user.id);
    await auth(request(app).get('/reports/daily').query({ date: TODAY }));

    await generate(user.id);

    const res = await auth(request(app).get('/reports/daily').query({ date: TODAY }));
    expect(res.headers['x-cache']).toBe('MISS');
  });

  test("never returns another user's report", async () => {
    const alice = await seededUser();
    await generate(alice.user.id);

    const bob = await registerUser(app);
    const res = await bob.auth(request(app).get('/reports/daily').query({ date: TODAY }));

    // Bob has no report of his own, so he gets a 202 - never Alice's figures.
    expect(res.status).toBe(202);
  });

  test('rejects a malformed date', async () => {
    const { auth } = await seededUser();
    expect((await auth(request(app).get('/reports/daily').query({ date: '15-09-2026' }))).status).toBe(422);
  });

  test('rejects a malformed month', async () => {
    const { auth } = await seededUser();
    expect((await auth(request(app).get('/reports/monthly').query({ month: '2026-9-1' }))).status).toBe(422);
  });

  test('requires authentication', async () => {
    expect((await request(app).get('/reports/daily')).status).toBe(401);
  });
});
