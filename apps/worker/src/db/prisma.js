import { PrismaClient } from '@prisma/client';
import { logger } from '../logger.js';

// The worker's own client. Same database, separate process, separate pool - see
// apps/api/src/db/prisma.js.
export const prisma = new PrismaClient({ log: ['warn', 'error'] });

export const disconnectPostgres = async () => {
  await prisma.$disconnect();
  logger.info('postgres disconnected');
};
