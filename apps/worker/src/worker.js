import { Worker } from 'bullmq';
import { config } from './config.js';
import { logger } from './logger.js';
import { queueConnection, closeQueueConnection } from './queues/connection.js';
import { QUEUE_NAMES, closeQueues } from './queues/index.js';
import { startOutboxPublisher } from './processors/outbox.js';
import { analyticsProcessor } from './processors/analytics.js';
import { notificationProcessor } from './processors/notification.js';
import { disconnectPostgres } from './db/prisma.js';

logger.info(
  { instance: config.INSTANCE_ID, concurrency: config.WORKER_CONCURRENCY },
  'fintrack worker starting',
);

// Reports are still a placeholder: workstream J owns the snapshot logic. Analytics and
// notifications are real. A processor that throws is left to throw - BullMQ retries it
// and then parks it in the failed set, which is the only record of what could not be
// done. Swallowing the error here would make a stuck aggregate invisible.
const placeholder = (queueName) => async (job) => {
  logger.info(
    { queue: queueName, jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
    'job received - placeholder processor, no aggregate updated',
  );
};

const processorFor = {
  [QUEUE_NAMES.ANALYTICS]: analyticsProcessor,
  [QUEUE_NAMES.NOTIFICATIONS]: notificationProcessor,
  [QUEUE_NAMES.REPORTS]: placeholder(QUEUE_NAMES.REPORTS),
};

const publisher = startOutboxPublisher();

// One ioredis instance is shared: BullMQ duplicates it internally for each Worker's
// blocking connection, so the workers do not contend on a single blocked socket.
const workers = Object.values(QUEUE_NAMES).map((name) => {
  const worker = new Worker(name, processorFor[name], {
    connection: queueConnection,
    concurrency: config.WORKER_CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'job failed',
    );
  });

  // Unhandled 'error' on an EventEmitter throws. A connection blip must not take the
  // process down (invariant 8) - BullMQ reconnects on its own. One line per outage
  // rather than one per reconnect attempt, which is several a second.
  let warnedDown = false;
  worker.on('error', (err) => {
    if (warnedDown) return;
    warnedDown = true;
    logger.error({ queue: name, err: err.message || String(err) }, 'worker connection error');
  });
  worker.on('ready', () => {
    if (warnedDown) logger.info({ queue: name }, 'worker connection recovered');
    warnedDown = false;
  });

  return worker;
});

logger.info({ queues: Object.values(QUEUE_NAMES) }, 'worker ready');

let shuttingDown = false;

const shutdown = async (signal) => {
  // A second SIGINT while draining should not start a second teardown.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');

  // A job killed mid-flight would be redelivered anyway, but only after its lock
  // expires - 30s of nothing happening. Draining costs seconds and avoids that.
  const forced = setTimeout(() => {
    logger.error('forced shutdown after 15s drain timeout');
    process.exit(1);
  }, 15_000);
  forced.unref();

  try {
    // The publisher stops first: no point enqueuing work the workers are shutting down
    // on. Unpublished rows stay unpublished and the next process picks them up.
    await publisher.stop();
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await closeQueues();
    await Promise.allSettled([disconnectPostgres(), closeQueueConnection()]);
  } catch (err) {
    logger.error({ err: err.message }, 'error during shutdown');
  }

  clearTimeout(forced);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
