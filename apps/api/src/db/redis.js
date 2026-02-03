import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

// A Redis outage must degrade latency, never availability (CLAUDE.md invariant 8).
// ioredis retries in the background; callers use lib/cache.js, which swallows errors.
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  lazyConnect: false,
});

let warnedDown = false;

redis.on('error', (err) => {
  // One warning per outage rather than one per reconnect attempt.
  if (!warnedDown) {
    logger.warn({ err: err.message }, 'redis unavailable - falling back to postgres for cached reads');
    warnedDown = true;
  }
});

redis.on('ready', () => {
  if (warnedDown) logger.info('redis recovered');
  warnedDown = false;
});

// enableOfflineQueue is false so application commands fail fast instead of piling up
// during an outage. That also means a command issued in the initial connect window
// throws, so the probe waits briefly for readiness before deciding Redis is down.
const waitForReady = (timeoutMs) =>
  new Promise((resolve, reject) => {
    if (redis.status === 'ready') return resolve();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`redis not ready within ${timeoutMs}ms (status: ${redis.status})`));
    }, timeoutMs);
    const onReady = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timer);
      redis.off('ready', onReady);
    };
    redis.once('ready', onReady);
  });

export const checkRedis = async (timeoutMs = 1500) => {
  await waitForReady(timeoutMs);
  const pong = await redis.ping();
  return pong === 'PONG';
};

export const disconnectRedis = async () => {
  await redis.quit().catch(() => redis.disconnect());
  logger.info('redis disconnected');
};
