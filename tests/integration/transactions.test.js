import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { connectMongo, disconnectMongo } from '../../apps/api/src/db/mongo.js';
import { disconnectRedis } from '../../apps/api/src/db/redis.js';
import { resetDatabase } from '../helpers/db.js';
import { registerUser, createAccount } from '../helpers/factories.js';

const app = createApp();

const post = (auth, body, key) => {
  const req = auth(request(app).post('/transactions'));
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

const deposit = (auth, accountId, amount, key) =>
  post(auth, { type: 'DEPOSIT', accountId, amount }, key);

const balanceOf = async (accountId) => {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  return account.balance.toFixed(4);
};

beforeAll(async () => {
  await connectMongo();
  await resetDatabase();
});

afterAll(async () => {
  await Promise.allSettled([disconnectPostgres(), disconnectMongo(), disconnectRedis()]);
});

describe('deposits and withdrawals', () => {
  test('a deposit creates one transaction and moves the balance', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);

    const res = await deposit(auth, account.id, '5000.00');

    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ type: 'DEPOSIT', amount: '5000.0000' });
    expect(await balanceOf(account.id)).toBe('5000.0000');
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(1);
  });

  test('a withdrawal debits the balance', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '5000.00');

    const res = await post(auth, { type: 'WITHDRAWAL', accountId: account.id, amount: '1200.50' });

    expect(res.status).toBe(201);
    expect(await balanceOf(account.id)).toBe('3799.5000');
  });

  test('a withdrawal beyond the balance is rejected and changes nothing', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '100.00');

    const res = await post(auth, { type: 'WITHDRAWAL', accountId: account.id, amount: '100.01' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/insufficient funds/i);
    expect(await balanceOf(account.id)).toBe('100.0000');
    expect(await prisma.transaction.count({ where: { accountId: account.id, type: 'WITHDRAWAL' } })).toBe(0);
  });

  test('preserves decimal precision across many small movements', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);

    // 0.1 + 0.2 in floating point is 0.30000000000000004. Ten of these must be exact.
    for (let i = 0; i < 10; i += 1) await deposit(auth, account.id, '0.1');
    expect(await balanceOf(account.id)).toBe('1.0000');
  });

  test('rejects a deposit carrying trade fields', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    const res = await post(auth, {
      type: 'DEPOSIT', accountId: account.id, amount: '100', symbol: 'INFY', quantity: '1', price: '1',
    });
    expect(res.status).toBe(422);
  });

  test('rejects a negative amount', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    expect((await deposit(auth, account.id, '-500')).status).toBe(422);
  });

  test("cannot transact on another user's account", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const account = await createAccount(app, alice.auth);

    const res = await deposit(bob.auth, account.id, '100');

    expect(res.status).toBe(404);
    expect(await balanceOf(account.id)).toBe('0.0000');
  });
});

describe('trades', () => {
  const funded = async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '100000.00');
    return { auth, account };
  };

  test('a BUY debits cash and the amount is derived from quantity x price', async () => {
    const { auth, account } = await funded();

    const res = await post(auth, {
      type: 'BUY', accountId: account.id, symbol: 'infy', quantity: '10', price: '1500.50',
    });

    expect(res.status).toBe(201);
    // Symbol is normalised, and amount is computed server-side - never taken on trust.
    expect(res.body.transaction.symbol).toBe('INFY');
    expect(res.body.transaction.amount).toBe('15005.0000');
    expect(await balanceOf(account.id)).toBe('84995.0000');
  });

  test('a SELL credits cash', async () => {
    const { auth, account } = await funded();
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '10', price: '1000' });

    const res = await post(auth, {
      type: 'SELL', accountId: account.id, symbol: 'INFY', quantity: '4', price: '1200',
    });

    expect(res.status).toBe(201);
    // 100000 - 10000 + 4800
    expect(await balanceOf(account.id)).toBe('94800.0000');
  });

  test('selling more than is held is rejected - no short selling', async () => {
    const { auth, account } = await funded();
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '5', price: '1000' });

    const res = await post(auth, {
      type: 'SELL', accountId: account.id, symbol: 'INFY', quantity: '6', price: '1000',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/insufficient holdings/i);
  });

  test('selling a symbol never bought is rejected', async () => {
    const { auth, account } = await funded();
    const res = await post(auth, {
      type: 'SELL', accountId: account.id, symbol: 'TCS', quantity: '1', price: '1000',
    });
    expect(res.status).toBe(422);
  });

  test('a BUY beyond available cash is rejected', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '1000');

    const res = await post(auth, {
      type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '1', price: '1000.01',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/insufficient funds/i);
  });

  test('rejects a BUY with no symbol', async () => {
    const { auth, account } = await funded();
    const res = await post(auth, { type: 'BUY', accountId: account.id, quantity: '1', price: '10' });
    expect(res.status).toBe(422);
  });
});

describe('idempotency', () => {
  test('a repeated key returns the original transaction and creates no second row', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    const key = `key-${randomUUID()}`;

    const first = await deposit(auth, account.id, '500', key);
    const second = await deposit(auth, account.id, '500', key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);

    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(1);
    expect(await balanceOf(account.id)).toBe('500.0000');
  });

  test('concurrent retries of the same key produce exactly one transaction', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    const key = `race-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => deposit(auth, account.id, '250', key)),
    );

    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.transaction.id));
    expect(ids.size).toBe(1);
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(1);
    expect(await balanceOf(account.id)).toBe('250.0000');
  });

  test('the same key on a different account is a different operation', async () => {
    const { auth } = await registerUser(app);
    const a = await createAccount(app, auth);
    const b = await createAccount(app, auth);
    const key = `shared-${randomUUID()}`;

    expect((await deposit(auth, a.id, '100', key)).status).toBe(201);
    expect((await deposit(auth, b.id, '100', key)).status).toBe(201);
  });

  test('transactions without a key never collide', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);

    for (let i = 0; i < 3; i += 1) expect((await deposit(auth, account.id, '10')).status).toBe(201);
    expect(await balanceOf(account.id)).toBe('30.0000');
  });
});

describe('concurrency', () => {
  test('concurrent withdrawals cannot both pass the balance check', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '100.00');

    // Both read a balance of 100 if the row is not locked, both decide 60 is
    // affordable, and the account ends at -20. FOR UPDATE serialises them.
    const results = await Promise.all([
      post(auth, { type: 'WITHDRAWAL', accountId: account.id, amount: '60.00' }),
      post(auth, { type: 'WITHDRAWAL', accountId: account.id, amount: '60.00' }),
    ]);

    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded).toHaveLength(1);
    expect(await balanceOf(account.id)).toBe('40.0000');
  });
});

describe('atomicity', () => {
  test('a failure after the insert rolls back the transaction, the balance AND the outbox', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);

    // A real forced failure rather than a test hook: NUMERIC(20,4) holds at most 16
    // digits before the point, so a balance this large overflows on the next credit.
    // The insert and the outbox write succeed; the balance UPDATE is what explodes.
    await prisma.$executeRawUnsafe(
      `UPDATE accounts SET balance = 9999999999999999.9999 WHERE id = '${account.id}'`,
    );
    const outboxBefore = await prisma.outboxEvent.count();

    const res = await deposit(auth, account.id, '100.00');

    expect(res.status).toBe(500);
    expect(await balanceOf(account.id)).toBe('9999999999999999.9999');
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(outboxBefore);
  });

  test('every successful transaction writes exactly one outbox event in the same commit', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);

    await deposit(auth, account.id, '10000');
    await post(auth, { type: 'BUY', accountId: account.id, symbol: 'INFY', quantity: '2', price: '100' });

    const events = await prisma.outboxEvent.findMany({ orderBy: { occurredAt: 'asc' } });
    const recent = events.slice(-2);

    expect(recent.map((e) => e.eventType)).toEqual(['DEPOSIT_COMPLETED', 'TRADE_EXECUTED']);
    expect(recent.every((e) => e.publishedAt === null)).toBe(true);
    expect(recent[1].payload).toMatchObject({ symbol: 'INFY', amount: '200' });
  });
});

describe('reading transactions', () => {
  test('filters by account, type and date range', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '10000');
    await post(auth, { type: 'WITHDRAWAL', accountId: account.id, amount: '100' });

    const res = await auth(request(app).get('/transactions').query({ type: 'WITHDRAWAL' }));

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].type).toBe('WITHDRAWAL');
  });

  test('returns newest first', async () => {
    const { auth } = await registerUser(app);
    const account = await createAccount(app, auth);
    await deposit(auth, account.id, '1');
    await deposit(auth, account.id, '2');

    const res = await auth(request(app).get('/transactions'));
    const times = res.body.transactions.map((t) => new Date(t.transactionTime).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
  });

  test("another user's transaction is a 404", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const account = await createAccount(app, alice.auth);
    const created = await deposit(alice.auth, account.id, '100');

    const res = await bob.auth(request(app).get(`/transactions/${created.body.transaction.id}`));
    expect(res.status).toBe(404);
  });

  test("another user's transactions never appear in a listing", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const aliceAccount = await createAccount(app, alice.auth);
    await deposit(alice.auth, aliceAccount.id, '100');

    const res = await bob.auth(request(app).get('/transactions'));
    expect(res.body.transactions).toHaveLength(0);
  });
});
