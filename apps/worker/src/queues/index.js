import { Queue } from 'bullmq';
import { queueConnection } from './connection.js';

// The worker's view of the same three queues. Mirrored from apps/api/src/queues/index.js
// rather than imported for the reason given in connection.js: the two processes ship
// independently and the worker must not depend on the API's module tree. The names are
// the wire contract between them, so they are literals in both places and a mismatch
// fails loudly (see the unmapped-event path in processors/outbox.js) rather than quietly.

export const QUEUE_NAMES = Object.freeze({
  ANALYTICS: 'analytics',
  REPORTS: 'reports',
  NOTIFICATIONS: 'notifications',
});

export const defaultJobOptions = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  // Retention is what lets BullMQ deduplicate a redelivered jobId; see the note in
  // apps/api/src/queues/index.js.
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400, count: 5000 },
});

const build = (name) => new Queue(name, { connection: queueConnection, defaultJobOptions });

export const queues = Object.freeze({
  [QUEUE_NAMES.ANALYTICS]: build(QUEUE_NAMES.ANALYTICS),
  [QUEUE_NAMES.REPORTS]: build(QUEUE_NAMES.REPORTS),
  [QUEUE_NAMES.NOTIFICATIONS]: build(QUEUE_NAMES.NOTIFICATIONS),
});

// Where each outbox event type is delivered. Event type names are owned by
// apps/api/src/lib/outbox.js; an event type missing from this map is a deployment
// mistake, and the publisher treats it as a failure so the row waits for the fix
// instead of being dropped.
export const EVENT_ROUTES = Object.freeze({
  DEPOSIT_COMPLETED: QUEUE_NAMES.ANALYTICS,
  WITHDRAWAL_COMPLETED: QUEUE_NAMES.ANALYTICS,
  TRADE_EXECUTED: QUEUE_NAMES.ANALYTICS,
});

export const closeQueues = async () => {
  await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
};
