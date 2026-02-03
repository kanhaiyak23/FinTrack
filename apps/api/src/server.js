import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { disconnectPostgres } from './db/prisma.js';
import { disconnectRedis } from './db/redis.js';

const app = createApp();

// Mongo connects eagerly so a misconfigured URL fails at boot, not on first write.
await connectMongo().catch((err) => {
  logger.error({ err: err.message }, 'mongodb connection failed at startup');
  process.exit(1);
});

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, instance: config.INSTANCE_ID },
    'fintrack api listening',
  );
});

// Stop accepting connections, drain in-flight requests, then close dependencies.
const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await Promise.allSettled([disconnectPostgres(), disconnectMongo(), disconnectRedis()]);
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('forced shutdown after 10s drain timeout');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
