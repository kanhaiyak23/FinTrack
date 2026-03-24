import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

// The worker's BullMQ connection. It mirrors apps/api/src/queues/connection.js rather
// than importing it: the two processes are independently deployable and the worker
// must not pull in the API's configuration (which requires a JWT secret it has no use
// for). The settings are the ones BullMQ requires and are deliberately NOT the ones
// the API's cache client uses:
//
//   maxRetriesPerRequest: null - BullMQ's blocking commands (BZPOPMIN) legitimately sit
//     open for seconds. A connection that gives up after N attempts would abandon a
//     worker mid-wait, so BullMQ throws at construction time when this is anything but
//     null. apps/api/src/db/redis.js uses 2 because a cached read must fail fast, and
//     that is correct there and wrong here.
//   enableOfflineQueue: true - a job enqueued during a reconnect window is buffered
//     rather than dropped. Dropping it would cost an outbox row its delivery.
//
// A consequence worth naming: with maxRetriesPerRequest null, a command issued while
// Redis is unreachable waits indefinitely instead of rejecting. The outbox publisher
// therefore imposes its own deadline on every enqueue (invariant 8).
export const queueConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

let warnedDown = false;

queueConnection.on('error', (err) => {
  // One warning per outage rather than one per reconnect attempt.
  if (!warnedDown) {
    logger.warn({ err: err.message || String(err) }, 'queue redis unavailable - retrying in background');
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
