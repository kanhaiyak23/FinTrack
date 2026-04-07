import { logger } from '../logger.js';
import { prisma } from '../db/prisma.js';
import { processOnce } from '../services/idempotency.js';

const PROCESSOR = 'notification';

// There is no delivery channel wired up - no email provider, no push service, nothing
// that leaves the machine. This records that a notification WOULD have been sent and
// stops there, deliberately: inventing a provider integration nobody asked for would be
// scope the project does not need, and pretending to deliver would be worse.
//
// It still goes through the idempotency ledger, because the day a real channel is
// attached, "delivered twice" becomes a user-visible bug and the guard needs to already
// be in the right place.
export const notificationProcessor = async (job) => {
  const { eventId, userId, channel = 'log', template = job.name } = job.data;

  // Jobs produced directly by the API carry no eventId; only outbox-derived jobs do.
  // Without one there is nothing stable to deduplicate on, so it runs unguarded.
  if (!eventId) {
    logger.info({ jobId: job.id, userId, channel, template }, 'notification (no delivery channel configured)');
    return { delivered: false, reason: 'no-channel' };
  }

  const { processed } = await processOnce(
    prisma,
    { eventId, processor: PROCESSOR },
    async () => {
      logger.info({ eventId, userId, channel, template }, 'notification (no delivery channel configured)');
    },
  );

  return { delivered: false, reason: 'no-channel', skipped: !processed };
};
