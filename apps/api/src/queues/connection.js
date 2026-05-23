import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

// BullMQ gets its own connection instead of sharing db/redis.js, because the two
// settings that make db/redis.js correct for a cache make it unusable for a queue:
//
//   maxRetriesPerRequest: 2  - BullMQ's blocking commands legitimately sit open for
//     seconds, so a command that gives up after two attempts would abandon a worker
//     mid-wait. BullMQ refuses to start on such a connection and throws at construction.
//   enableOfflineQueue: false - a cached read should fail fast and fall through to
//     Postgres, but a job enqueued during a reconnect window should be buffered rather
//     than dropped.
//
// Neither is a defect in db/redis.js. They are different jobs, so they get different
// connections.
//
// Created on FIRST USE, not on import. app.js reaches this module transitively through
// the reports producer, so an eager connection would mean every process that merely
// builds the Express app - including a test that never enqueues anything - holds an open
// socket and cannot exit.

let connection = null;
let warnedDown = false;

export const getQueueConnection = () => {
  if (connection) return connection;

  connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  connection.on('error', (err) => {
    // One warning per outage rather than one per reconnect attempt.
    if (!warnedDown) {
      logger.warn({ err: err.message || String(err) }, 'queue redis unavailable - retrying in background');
      warnedDown = true;
    }
  });

  connection.on('ready', () => {
    if (warnedDown) logger.info('queue redis recovered');
    warnedDown = false;
  });

  return connection;
};

export const closeQueueConnection = async () => {
  if (!connection) return;
  const open = connection;
  connection = null;
  warnedDown = false;
  await open.quit().catch(() => open.disconnect());
};
