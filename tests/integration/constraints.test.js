import { randomUUID } from 'node:crypto';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { disconnectRedis } from '../../apps/api/src/db/redis.js';
import { resetDatabase } from '../helpers/db.js';

// These tests bypass the API and the service layer, writing raw SQL directly. The
// point is that the invariants hold even when the application is wrong: a bug in a
// service must not be able to persist an impossible state.

let userId;
let accountId;

// Postgres will not implicitly cast a text parameter into an enum column, so the
// enum-typed placeholders carry an explicit cast.
const ENUM_CASTS = { type: '::transaction_type', status: '::transaction_status' };

const insertTransaction = (columns, account = accountId) => {
  const keys = Object.keys(columns);
  const values = Object.values(columns);
  const placeholders = keys.map((k, i) => `$${i + 1}${ENUM_CASTS[k] ?? ''}`).join(', ');
  const quoted = keys.map((k) => `"${k}"`).join(', ');
  return prisma.$executeRawUnsafe(
    `INSERT INTO transactions (id, account_id, ${quoted}) VALUES (gen_random_uuid(), '${account}', ${placeholders})`,
    ...values,
  );
};

beforeAll(async () => {
  await resetDatabase();
  const user = await prisma.user.create({
    data: { email: `constraints-${randomUUID()}@example.com`, name: 'C', passwordHash: 'x' },
  });
  userId = user.id;
  const account = await prisma.account.create({
    data: { userId, accountType: 'BROKERAGE', balance: '1000.0000' },
  });
  accountId = account.id;
});

afterAll(async () => {
  await Promise.allSettled([disconnectPostgres(), disconnectRedis()]);
});

describe('database-enforced invariants', () => {
  test('a balance cannot go negative', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE accounts SET balance = -1 WHERE id = '${accountId}'`,
      ),
    ).rejects.toThrow(/chk_accounts_balance_non_negative/);
  });

  test('a transaction amount must be positive - direction comes from the type', async () => {
    await expect(
      insertTransaction({ type: 'DEPOSIT', amount: -500 }),
    ).rejects.toThrow(/chk_transactions_amount_positive/);
  });

  test('a BUY without a symbol is rejected', async () => {
    await expect(
      insertTransaction({ type: 'BUY', amount: 100 }),
    ).rejects.toThrow(/chk_transactions_trade_fields/);
  });

  test('a DEPOSIT carrying trade fields is rejected', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO transactions (id, account_id, type, symbol, quantity, price, amount)
         VALUES (gen_random_uuid(), '${accountId}', 'DEPOSIT', 'INFY', 10, 100, 1000)`,
      ),
    ).rejects.toThrow(/chk_transactions_trade_fields/);
  });

  test('a well-formed BUY is accepted', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO transactions (id, account_id, type, symbol, quantity, price, amount)
         VALUES (gen_random_uuid(), '${accountId}', 'BUY', 'INFY', 10, 100, 1000)`,
      ),
    ).resolves.toBe(1);
  });

  test('an unknown transaction type cannot be written at all', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO transactions (id, account_id, type, amount)
         VALUES (gen_random_uuid(), '${accountId}', 'TRANSFER', 100)`,
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  test('the same idempotency key cannot be reused within an account', async () => {
    const key = `key-${randomUUID()}`;
    await insertTransaction({ type: 'DEPOSIT', amount: 100, idempotency_key: key });
    await expect(
      insertTransaction({ type: 'DEPOSIT', amount: 100, idempotency_key: key }),
      // Prisma's raw error names the key columns rather than the index, so assert
      // on the unique-violation code and the column pair that collided.
    ).rejects.toThrow(/23505|\(account_id, idempotency_key\)/);
  });

  test('two different accounts may use the same idempotency key', async () => {
    const other = await prisma.account.create({ data: { userId, accountType: 'SAVINGS' } });
    const key = `shared-${randomUUID()}`;

    await insertTransaction({ type: 'DEPOSIT', amount: 100, idempotency_key: key });
    await expect(
      insertTransaction({ type: 'DEPOSIT', amount: 100, idempotency_key: key }, other.id),
    ).resolves.toBe(1);
  });

  test('unkeyed transactions never collide, however many there are', async () => {
    // NULLs are distinct in a Postgres unique index, which is exactly what makes a
    // plain unique constraint behave as "unique when supplied".
    for (let i = 0; i < 3; i += 1) {
      await expect(insertTransaction({ type: 'DEPOSIT', amount: 50 })).resolves.toBe(1);
    }
  });

  test('a cancelled subscription must record when it ended', async () => {
    const plan = await prisma.investmentPlan.create({
      data: { userId, name: 'P', planType: 'SIP', amount: 100, frequency: 'MONTHLY', startDate: new Date() },
    });
    const sub = await prisma.subscription.create({ data: { userId, planId: plan.id } });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE subscriptions SET status = 'CANCELLED' WHERE id = '${sub.id}'`,
      ),
    ).rejects.toThrow(/chk_subscriptions_ended_at/);
  });

  test('a deleted user takes their accounts and transactions with them', async () => {
    const doomed = await prisma.user.create({
      data: { email: `doomed-${randomUUID()}@example.com`, name: 'D', passwordHash: 'x' },
    });
    const acct = await prisma.account.create({
      data: { userId: doomed.id, accountType: 'CHECKING' },
    });
    await prisma.transaction.create({
      data: { accountId: acct.id, type: 'DEPOSIT', amount: 10 },
    });

    await prisma.user.delete({ where: { id: doomed.id } });

    expect(await prisma.account.count({ where: { id: acct.id } })).toBe(0);
    expect(await prisma.transaction.count({ where: { accountId: acct.id } })).toBe(0);
  });
});
