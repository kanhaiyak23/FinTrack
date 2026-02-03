import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

export const prisma = new PrismaClient({
  log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export const checkPostgres = async () => {
  await prisma.$queryRaw`SELECT 1`;
  return true;
};

export const disconnectPostgres = async () => {
  await prisma.$disconnect();
  logger.info('postgres disconnected');
};
