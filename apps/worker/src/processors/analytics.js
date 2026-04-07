import { logger } from '../logger.js';
import { prisma } from '../db/prisma.js';
import { processOnce } from '../services/idempotency.js';
import { applyEvent } from '../services/analytics.js';

const PROCESSOR = 'analytics';

// BullMQ delivers at least once, and the outbox publisher can legitimately re-enqueue a
// row after a crash between enqueue and commit. Both are normal, so this has to be safe
// to run twice: processOnce claims the event and applies the aggregate change in ONE
// transaction, so the claim and the effect commit together or not at all.
export const analyticsProcessor = async (job) => {
  const event = job.data;

  const { processed } = await processOnce(
    prisma,
    { eventId: event.eventId, processor: PROCESSOR },
    (tx) => applyEvent(tx, event),
  );

  if (!processed) {
    // Not a failure. A redelivery finding its own earlier work is the system behaving
    // exactly as designed - worth a debug line, not a warning.
    logger.debug({ eventId: event.eventId, jobId: job.id }, 'analytics event already applied');
    return { applied: false };
  }

  logger.info(
    { eventId: event.eventId, eventType: event.eventType, userId: event.userId },
    'analytics aggregates updated',
  );
  return { applied: true };
};
