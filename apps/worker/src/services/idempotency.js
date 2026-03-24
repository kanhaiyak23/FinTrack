import { logger } from '../logger.js';

// The worker-side half of ADR-008. BullMQ delivers at least once and the outbox
// publisher can legitimately re-enqueue a row after a crash, so a processor that
// mutates an aggregate has to be able to see the same event twice and change nothing
// the second time (CLAUDE.md invariant 7).
//
// The ledger is a Postgres table rather than a Redis key because durability is the
// entire point: a cache flush must not turn a redelivery into a double count.

// Takes the CALLER's transaction, never opening its own. The claim and the aggregate
// update have to commit together - a claim that commits separately would mark an event
// done that a subsequent failure rolled back, and the event would never be applied.
export const claimEvent = async (tx, { eventId, processor }) => {
  // One statement, INSERT ... ON CONFLICT DO NOTHING under the hood. A check followed
  // by an insert would let two workers holding the same redelivered job both read
  // "not processed" before either wrote; here exactly one insert reports a row.
  const { count } = await tx.processedEvent.createMany({
    data: [{ eventId, processor }],
    skipDuplicates: true,
  });
  return count === 1;
};

export const hasProcessed = async (tx, { eventId, processor }) => {
  const row = await tx.processedEvent.findUnique({
    where: { eventId_processor: { eventId, processor } },
  });
  return row !== null;
};

// The shape every processor wants: claim and work in one transaction, and skip
// silently if someone already did it. `work` receives the same tx the claim was made
// in and must do all its writes through it.
export const processOnce = async (client, { eventId, processor }, work, options) =>
  client.$transaction(async (tx) => {
    if (!(await claimEvent(tx, { eventId, processor }))) {
      logger.debug({ eventId, processor }, 'event already processed - skipping');
      return { processed: false, result: undefined };
    }
    return { processed: true, result: await work(tx) };
  }, options);
