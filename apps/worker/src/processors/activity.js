import { logger } from '../logger.js';
import { activityEvents } from '../db/mongo.js';

const PROCESSOR = 'activity';

// Activity history lives in MongoDB because the metadata differs per event type: a trade
// carries symbol, quantity and price; a login would carry a device and an address. A
// relational table would be a wide sheet of mostly-NULL columns, or a JSONB blob that
// gains nothing from being in Postgres.
//
// Unlike the analytics processor this does NOT use processed_events. Idempotency comes
// from the unique index on eventId instead, because the write and the ledger entry live
// in different databases and cannot share a transaction - claiming in Postgres and then
// failing to write to Mongo would mark an event recorded that is not. A duplicate key
// error from Mongo is the authoritative "already recorded", and it needs no second
// source of truth.
export const activityProcessor = async (job) => {
  const event = job.data;

  const document = {
    eventId: event.eventId,
    userId: event.userId,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    // Whatever the producing service chose to record. Deliberately unvalidated here:
    // the shape varies by event type and constraining it would defeat the purpose of
    // storing it in a document database.
    metadata: event.payload ?? {},
    occurredAt: new Date(event.occurredAt ?? Date.now()),
    processedAt: new Date(),
  };

  try {
    await activityEvents().insertOne(document);
  } catch (err) {
    if (err?.code === 11000) {
      // Redelivery. The history already has this event; writing it again would show the
      // user the same action twice.
      logger.debug({ eventId: event.eventId, jobId: job.id }, 'activity event already recorded');
      return { recorded: false };
    }
    throw err;
  }

  logger.info(
    { eventId: event.eventId, eventType: event.eventType, userId: event.userId },
    'activity event recorded',
  );
  return { recorded: true, processor: PROCESSOR };
};
