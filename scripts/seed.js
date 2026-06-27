import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../apps/api/src/db/prisma.js';

// Generates a dataset large enough for index measurements to mean anything. On a few
// thousand rows Postgres ignores an index and the numbers are noise, so the default is
// deliberately large (ADR-012).
//
// Rows are inserted with createMany in batches rather than one at a time: the point is
// to produce data, not to exercise the API, and going through HTTP would take hours.

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const USERS = arg('users', 200);
const TRANSACTIONS = arg('transactions', 500_000);
const BATCH = 5_000;
const SYMBOLS = ['INFY', 'TCS', 'WIPRO', 'HDFC', 'ITC', 'SBIN', 'RELIANCE', 'AXIS'];

const randomOf = (xs) => xs[Math.floor(Math.random() * xs.length)];

const main = async () => {
  const startedAt = Date.now();
  console.log(`seeding ${USERS} users and ${TRANSACTIONS} transactions`);

  const passwordHash = await bcrypt.hash('seed-password', 10);
  const users = Array.from({ length: USERS }, () => ({
    id: randomUUID(),
    email: `seed-${randomUUID()}@example.com`,
    name: 'Seed User',
    passwordHash,
  }));
  await prisma.user.createMany({ data: users });

  const accounts = users.map((u) => ({
    id: randomUUID(),
    userId: u.id,
    accountType: 'BROKERAGE',
    balance: '10000000.0000',
  }));
  await prisma.account.createMany({ data: accounts });

  // Spread over a year so date-range filters and the daily aggregate have something to
  // bite on; a dataset all written "now" would make every range query trivial.
  const now = Date.now();
  const YEAR_MS = 365 * 24 * 3600 * 1000;

  let written = 0;
  while (written < TRANSACTIONS) {
    const size = Math.min(BATCH, TRANSACTIONS - written);
    const rows = Array.from({ length: size }, () => {
      const account = randomOf(accounts);
      const isTrade = Math.random() < 0.7;
      const at = new Date(now - Math.random() * YEAR_MS);

      if (!isTrade) {
        return {
          accountId: account.id,
          type: Math.random() < 0.6 ? 'DEPOSIT' : 'WITHDRAWAL',
          amount: (Math.random() * 10000 + 1).toFixed(4),
          transactionTime: at,
        };
      }

      const quantity = (Math.random() * 20 + 1).toFixed(8);
      const price = (Math.random() * 2000 + 50).toFixed(4);
      return {
        accountId: account.id,
        type: Math.random() < 0.6 ? 'BUY' : 'SELL',
        symbol: randomOf(SYMBOLS),
        quantity,
        price,
        amount: (Number(quantity) * Number(price)).toFixed(4),
        transactionTime: at,
      };
    });

    await prisma.transaction.createMany({ data: rows });
    written += size;
    if (written % 50_000 === 0) console.log(`  ${written}/${TRANSACTIONS}`);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`done in ${seconds}s`);
  console.log(`sample account for benchmarks: ${accounts[0].id}`);
  await prisma.$disconnect();
};

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
