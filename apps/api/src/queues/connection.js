import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

// BullMQ gets its own connection instead of sharing db/redis.js, because the two
// settings that make db/redis.js correct for a cache make it unusable for a queue:
//
//   maxRetriesPerRequest: 2  - BullMQ's blocking commands (BZPOPMIN) legitimately sit
//     open for seconds, so a command that gives up after two attempts would abandon a
//     worker mid-wait. BullMQ refuses to start on a connection where this is set and
//     throws at construction time rather than misbehave later.
//   enableOfflineQueue: false - a cached read should fail fast and fall through to
//     Postgres, but a job enqueue during a reconnect window should be buffered, not
//     dropped: dropping it loses the outbox row's only delivery attempt.
//
// Neither of those is a defect in db/redis.js. They are different jobs, so they get
// different connections.
export const queueConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

let warnedDown = false;

queueConnection.on('error', (err) => {
  // One warning per outage rather than one per reconnect attempt.
  if (!warnedDown) {
    logger.warn({ err: err.message || String(err) }, 'queue redis unavailable - producers will buffer');
    warnedDown = true;
  }
});

queueConnection.on('ready', () => {
  if (warnedDown) logger.info('queue redis recovered');
  warnedDown = false;
});

export const closeQueueConnection = async () => {
  await queueConnection.quit().catch(() => queueConnection.disconnect());
};
