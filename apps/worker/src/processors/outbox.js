import { logger } from '../logger.js';
import { prisma } from '../db/prisma.js';
import { queues, EVENT_ROUTES } from '../queues/index.js';

// The other half of ADR-005. Business writes leave rows in outbox_events inside their
// own transaction; this is the only thing that turns them into jobs. Delivery is
// at-least-once by construction, which is why every processor also checks
// processed_events (ADR-008, services/idempotency.js).

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 1000;
// A failed pass is almost always Redis or Postgres being briefly unavailable. Backing
// off further than the idle poll keeps the logs readable during an outage.
const ERROR_BACKOFF_MS = 5000;
// The queue connection uses maxRetriesPerRequest: null, so an enqueue against an
// unreachable Redis never rejects on its own. Without a deadline it would hold the
// claim transaction - and its row locks - open until Postgres killed it.
const ENQUEUE_TIMEOUT_MS = 2000;
// The claim transaction holds row locks, so it gets a hard budget. It is sized for a
// healthy Redis rather than for batchSize * ENQUEUE_TIMEOUT_MS, which would be minutes;
// a sick Redis trips the enqueue deadline and abandons the pass long before this.
const CLAIM_TIMEOUT_MS = 15_000;

const withDeadline = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Raw SQL because Prisma cannot express FOR UPDATE SKIP LOCKED, and SKIP LOCKED is the
// whole mechanism: two publisher instances polling at the same moment take disjoint
// sets of rows instead of both claiming the head of the backlog. The locks are held
// until the surrounding transaction commits, which is also when published_at is set -
// so there is no window in which a row is claimed but unmarked and visible to a peer.
// ORDER BY occurred_at keeps a user's events in the order they happened.
//
// There is deliberately no cap on attempts. A row that has failed a hundred times is an
// operator's problem, visible as a high attempts count and a last_error - but excluding
// it from the claim would silently drop an event, which is the one outcome the outbox
// exists to prevent.
const claim = (tx, batchSize) => tx.$queryRaw`
  SELECT id, event_type, entity_type, entity_id, user_id, payload, occurred_at, attempts
  FROM outbox_events
  WHERE published_at IS NULL
  ORDER BY occurred_at ASC
  LIMIT ${batchSize}
  FOR UPDATE SKIP LOCKED`;

const jobDataFor = (row) => ({
  eventId: row.id,
  eventType: row.event_type,
  entityType: row.entity_type,
  entityId: row.entity_id,
  userId: row.user_id,
  payload: row.payload,
  occurredAt: row.occurred_at.toISOString(),
});

// Resolved before the enqueue is attempted, so "this row can never be delivered" and
// "Redis is unreachable" stay distinguishable - they need opposite responses.
const routeFor = (eventType) => {
  const queueName = EVENT_ROUTES[eventType];
  if (!queueName) return { error: `no queue mapped for event type ${eventType}` };

  const queue = queues[queueName];
  if (!queue) return { error: `event type ${eventType} routes to unknown queue ${queueName}` };

  return { queueName, queue };
};

// The outbox row id IS the job id. If this process dies between the enqueue and the
// commit, the row is still unpublished and gets re-enqueued - onto the job that already
// exists, not a second one.
const enqueue = (queue, queueName, row) =>
  withDeadline(
    queue.add(row.event_type, jobDataFor(row), { jobId: row.id }),
    ENQUEUE_TIMEOUT_MS,
    `enqueue to ${queueName} timed out after ${ENQUEUE_TIMEOUT_MS}ms`,
  );

// One pass. Exported separately from the loop so a caller - the tests, or an operator
// draining a backlog - can run exactly one and see what it did.
export const publishBatch = async ({ batchSize = BATCH_SIZE } = {}) =>
  prisma.$transaction(
    async (tx) => {
      const rows = await claim(tx, batchSize);
      if (rows.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const published = [];
      const failures = [];

      // Sequential, not Promise.all: ordering within a batch is the point, and a
      // hundred concurrent enqueues against one connection buys nothing.
      for (const row of rows) {
        const { queue, queueName, error } = routeFor(row.event_type);
        if (error) {
          // The row is at fault, not the transport. Record it and keep going, so one
          // unroutable event cannot hold up everything behind it in the batch.
          failures.push({ id: row.id, message: error });
          continue;
        }

        try {
          await enqueue(queue, queueName, row);
          published.push(row.id);
        } catch (err) {
          // An enqueue that fails is almost always Redis, not this row - and every
          // remaining row would sit out the same deadline for the same reason. Stop
          // here: the untried rows keep published_at NULL and attempts 0, and the next
          // pass claims them once Redis is back.
          failures.push({ id: row.id, message: err.message || String(err) });
          break;
        }
      }

      if (published.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: published } },
          data: { publishedAt: new Date() },
        });
      }

      for (const failure of failures) {
        // published_at stays NULL on purpose: the row is claimed again next pass. The
        // attempt count and the message are what make a stuck row visible in SQL.
        await tx.outboxEvent.update({
          where: { id: failure.id },
          data: { attempts: { increment: 1 }, lastError: failure.message.slice(0, 500) },
        });
      }

      return { claimed: rows.length, published: published.length, failed: failures.length };
    },
    { timeout: CLAIM_TIMEOUT_MS },
  );

export const startOutboxPublisher = ({
  batchSize = BATCH_SIZE,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) => {
  let running = true;
  let interrupt = () => {};

  // stop() resolves the current wait immediately, so shutdown does not sit out a
  // backoff it is about to abandon anyway.
  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      interrupt = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    logger.info({ batchSize, pollIntervalMs }, 'outbox publisher started');

    while (running) {
      try {
        const result = await publishBatch({ batchSize });

        if (result.published > 0) logger.info(result, 'outbox batch published');
        if (result.failed > 0) {
          logger.warn(result, 'outbox rows left unpublished for retry');
        }

        // A full batch that went through cleanly means there is more behind it; drain
        // before sleeping. A batch cut short by a failure must NOT skip the pause, or
        // an outage turns into a tight loop against both Redis and Postgres.
        if (result.claimed === batchSize && result.failed === 0) continue;
        await pause(pollIntervalMs);
      } catch (err) {
        // Redis unreachable, Postgres restarting, claim transaction timed out: none of
        // these is worth killing the process over, and none of them loses a row -
        // published_at is only ever set on a committed pass. Log, back off, keep going
        // (CLAUDE.md invariant 8).
        logger.error({ err: err.message || String(err) }, 'outbox publish pass failed - backing off');
        await pause(ERROR_BACKOFF_MS);
      }
    }

    logger.info('outbox publisher stopped');
  })();

  return {
    stop: async () => {
      running = false;
      interrupt();
      // Awaiting the loop means the in-flight pass finishes and commits before the
      // process tears its database connections down.
      await loop;
    },
  };
};
