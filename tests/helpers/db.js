import { prisma } from '../../apps/api/src/db/prisma.js';

// Truncate rather than delete so identity/sequence state resets too, and so adding
// tables later does not silently leave rows behind between suites.
export const resetDatabase = async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
};

export const uniqueEmail = (prefix = 'user') =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
