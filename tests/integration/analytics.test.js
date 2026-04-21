import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../apps/api/src/app.js';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { connectMongo, disconnectMongo } from '../../apps/api/src/db/mongo.js';
import { redis, disconnectRedis } from '../../apps/api/src/db/redis.js';
import { analyticsProcessor } from '../../apps/worker/src/processors/analytics.js';
import { disconnectPostgres as disconnectWorkerPostgres } from '../../apps/worker/src/db/prisma.js';
import { disconnectCacheRedis } from '../../apps/worker/src/db/redis.js';
import { resetDatabase } from '../helpers/db.js';
import { registerUser, createAccount } from '../helpers/factories.js';

const app = createApp();

const post = (auth, body) => auth(request(app).post('/transactions')).send(body);

// Drives the worker directly rather than waiting on the publisher, so a test asserts on
// a settled state instead of racing a poll interval. The publisher's own behaviour is
// covered in queues.test.js.
const drainOutbox = async () => {
  const rows = await prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' } });
  for (const row of rows) {
    await analyticsProcessor({
      id: row.id,
      name: row.eventType,
      data: {
        eventId: row.id,
        eventType: row.eventType,
        entityType: row.entityType,
        entityId: row.entityId,
        userId: row.userId,
        payload: row.payload,
      },
    });
    await prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
  }
};

const fundedUser = async () => {
  const user = await registerUser(app);
  const account = await createAccount(app, user.auth);
  await post(user.auth, { type: 'DEPOSIT', accountId: account.id, amount: '100000' });
  return { ...user, account };
};

beforeEach(async () => {
  await resetDatabase();
  await redis.flushdb().catch(() => {});
});

beforeAll(async () => { await connectMongo(); });

afterAll(async () => {
  await Promise.allSettled([
    disconnectPostgres(), disconnectWorkerPostgres(), disconnectMongo(),
    disconnectRedis(), disconnectCacheRedis(),
  ]);
});

describe('GET /analytics/portfolio', () => {
  test('reports holdings, weighted average and cash', async () => {
    const { auth, account } = await fundedUser();
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '10', price: '100' });
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '10', price: '200' });
    await drainOutbox();

    const res = await auth(request(app).get('/analytics/portfolio'));

    expect(res.status).toBe(200);
    expect(res.body.holdings).toHaveLength(1);
    expect(res.body.holdings[0]).toMatchObject({
      symbol: 'INFY', quantity: '20.00000000', averageBuyPrice: '150.0000', costBasis: '3000.0000',
    });
    expect(res.body.cash.total).toBe('97000.0000');
  });

  test('omits market value and unrealised P&L rather than inventing them', async () => {
    const { auth } = await fundedUser();
    const res = await auth(request(app).get('/analytics/portfolio'));

    expect(res.body.totals.marketValue).toBeNull();
    expect(res.body.totals.unrealizedPnl).toBeNull();
  });

  test('a closed position is not listed as a holding', async () => {
    const { auth, account } = await fundedUser();
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'TCS', quantity: '5', price: '100' });
    await post(auth, { type: 'SELL', accountId: account.id, symbol: 'TCS', quantity: '5', price: '120' });
    await drainOutbox();

    const res = await auth(request(app).get('/analytics/portfolio'));
    expect(res.body.holdings).toHaveLength(0);
    // ...but the realised profit it produced survives.
    const pnl = await auth(request(app).get('/analytics/pnl'));
    expect(pnl.body.realized.total).toBe('100.0000');
  });

  test("never includes another user's holdings", async () => {
    const alice = await fundedUser();
    await post(alice.auth, { type: 'BUY', accountId: alice.account.id, symbol: 'INFY', quantity: '1', price: '100' });
    await drainOutbox();

    const bob = await fundedUser();
    const res = await bob.auth(request(app).get('/analytics/portfolio'));

    expect(res.body.holdings).toHaveLength(0);
    expect(res.body.cash.total).toBe('100000.0000');
  });

  test('requires authentication', async () => {
    expect((await request(app).get('/analytics/portfolio')).status).toBe(401);
  });
});

describe('GET /analytics/pnl', () => {
  test('reports realised P&L per symbol and states its method', async () => {
    const { auth, account } = await fundedUser();
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '10', price: '100' });
    await post(auth, { type: 'SELL', accountId: account.id, symbol: 'INFY', quantity: '5', price: '150' });
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'WIPRO', quantity: '10', price: '500' });
    await post(auth, { type: 'SELL', accountId: account.id, symbol: 'WIPRO', quantity: '10', price: '400' });
    await drainOutbox();

    const res = await auth(request(app).get('/analytics/pnl'));

    expect(res.body.method).toBe('WEIGHTED_AVERAGE');
    // +250 on INFY, -1000 on WIPRO
    expect(res.body.realized.total).toBe('-750.0000');
    const bySymbol = Object.fromEntries(res.body.realized.bySymbol.map((s) => [s.symbol, s.realizedPnl]));
    expect(bySymbol).toEqual({ INFY: '250.0000', WIPRO: '-1000.0000' });
    expect(res.body.unrealized).toBeNull();
  });
});

describe('GET /analytics/activity', () => {
  test('totals and a per-day series', async () => {
    const { auth, account } = await fundedUser();
    await post(auth, { type: 'WITHDRAWAL', accountId: account.id, amount: '500' });
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '2', price: '100' });
    await drainOutbox();

    const res = await auth(request(app).get('/analytics/activity'));

    expect(res.body.totals.transactionCount).toBe(3);
    expect(res.body.totals.deposits).toBe('100000.0000');
    expect(res.body.totals.withdrawals).toBe('500.0000');
    expect(res.body.totals.tradingVolume).toBe('200.0000');
    expect(res.body.activeDays).toBe(1);
    expect(res.body.series).toHaveLength(1);
  });

  test('a date range excludes days outside it', async () => {
    const { auth } = await fundedUser();
    await drainOutbox();

    const res = await auth(
      request(app).get('/analytics/activity').query({ from: '2020-01-01', to: '2020-01-31' }),
    );
    expect(res.body.totals.transactionCount).toBe(0);
    expect(res.body.activeDays).toBe(0);
  });
});

describe('caching', () => {
  test('a repeated request is served from Redis', async () => {
    const { auth } = await fundedUser();
    await drainOutbox();

    const first = await auth(request(app).get('/analytics/portfolio'));
    const second = await auth(request(app).get('/analytics/portfolio'));

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  test('the worker invalidates the cache when aggregates change', async () => {
    const { auth, account } = await fundedUser();
    await drainOutbox();

    await auth(request(app).get('/analytics/portfolio'));
    expect((await auth(request(app).get('/analytics/portfolio'))).headers['x-cache']).toBe('HIT');

    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '3', price: '100' });
    await drainOutbox();

    const after = await auth(request(app).get('/analytics/portfolio'));
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body.holdings[0].quantity).toBe('3.00000000');
  });

  test('a filtered activity range is not cached under the shared key', async () => {
    const { auth } = await fundedUser();
    await drainOutbox();

    const ranged = await auth(request(app).get('/analytics/activity').query({ from: '2020-01-01' }));
    const unfiltered = await auth(request(app).get('/analytics/activity'));

    // If the ranged result had been stored under the shared key, this would be a HIT
    // serving the wrong range.
    expect(ranged.headers['x-cache']).toBe('MISS');
    expect(unfiltered.headers['x-cache']).toBe('MISS');
    expect(unfiltered.body.totals.transactionCount).toBe(1);
  });

  test("one user's cached analytics are never served to another", async () => {
    const alice = await fundedUser();
    await post(alice.auth, { type: 'BUY', accountId: alice.account.id, symbol: 'INFY', quantity: '7', price: '100' });
    await drainOutbox();
    await alice.auth(request(app).get('/analytics/portfolio'));

    const bob = await fundedUser();
    const res = await bob.auth(request(app).get('/analytics/portfolio'));

    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body.holdings).toHaveLength(0);
  });
});

describe('cache failure', () => {
  const redisCompose = (action) =>
    execFileSync('docker', ['compose', action, 'redis'], { cwd: process.cwd(), stdio: 'pipe' });

  // The headline claim of invariant 8, proven against a genuinely stopped Redis rather
  // than a mocked client that throws.
  test('analytics stay correct and available with Redis down', async () => {
    const { auth, account } = await fundedUser();
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '4', price: '250' });
    await drainOutbox();

    const expected = (await auth(request(app).get('/analytics/portfolio'))).body;

    redisCompose('stop');
    try {
      const res = await auth(request(app).get('/analytics/portfolio'));

      expect(res.status).toBe(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.body).toEqual(expected);
    } finally {
      redisCompose('start');
      // ioredis reconnects on its own; give it a moment so later suites are not
      // affected by a connection still in backoff.
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
    }
  }, 60000);
});
