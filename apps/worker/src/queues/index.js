import { Queue } from 'bullmq';
import { queueConnection } from './connection.js';
import { QUEUE_NAMES, EVENT_ROUTES } from './routes.js';

// Re-exported so callers that need queues keep one import; callers that need only the
// routing table import ./routes.js directly and open no connections.
export { QUEUE_NAMES, EVENT_ROUTES };

// The worker's view of the same three queues. Mirrored from apps/api/src/queues/index.js
// rather than imported for the reason given in connection.js: the two processes ship
// independently and the worker must not depend on the API's module tree. The names are
// the wire contract between them, so they are literals in both places and a mismatch
// fails loudly (see the unmapped-event path in processors/outbox.js) rather than quietly.

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
  [QUEUE_NAMES.ACTIVITY]: build(QUEUE_NAMES.ACTIVITY),
  [QUEUE_NAMES.REPORTS]: build(QUEUE_NAMES.REPORTS),
  [QUEUE_NAMES.NOTIFICATIONS]: build(QUEUE_NAMES.NOTIFICATIONS),
});


export const closeQueues = async () => {
  await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
};
