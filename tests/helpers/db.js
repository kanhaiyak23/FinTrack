import { prisma } from '../../apps/api/src/db/prisma.js';

// CASCADE from users clears every dependent table, so adding a table later does not
// silently leave rows behind between suites.
export const resetDatabase = async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, outbox_events, processed_events RESTART IDENTITY CASCADE',
  );
};

export const uniqueEmail = (prefix = 'user') =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
