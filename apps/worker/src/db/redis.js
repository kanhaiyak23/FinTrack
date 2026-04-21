import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Separate from the BullMQ connection on purpose. This one is for cache invalidation,
// where a command must fail fast rather than wait indefinitely - the opposite of what
// BullMQ's blocking commands need. See queues/connection.js for that side.
export const cacheRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

let warnedDown = false;

cacheRedis.on('error', (err) => {
  if (!warnedDown) {
    logger.warn({ err: err.message || String(err) }, 'cache redis unavailable - invalidation will be skipped');
    warnedDown = true;
  }
});

cacheRedis.on('ready', () => {
  if (warnedDown) logger.info('cache redis recovered');
  warnedDown = false;
});

// Never throws. A failed invalidation degrades to TTL-bounded staleness (ADR-009); it
// must not fail the job, because the aggregate change it follows is already committed
// and retrying the job would be re-processing an event that is already applied.
export const invalidateUserAnalytics = async (userId) => {
  const keys = [
    `analytics:user:${userId}:portfolio`,
    `analytics:user:${userId}:activity`,
    `analytics:user:${userId}:pnl`,
  ];
  try {
    await cacheRedis.del(...keys);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'cache invalidation failed - TTL will expire it');
  }
};

export const disconnectCacheRedis = async () => {
  await cacheRedis.quit().catch(() => cacheRedis.disconnect());
};
