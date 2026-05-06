import { activityRepository } from './repository.js';

const toPublicEvent = (doc) => ({
  eventId: doc.eventId,
  eventType: doc.eventType,
  entityType: doc.entityType,
  entityId: doc.entityId,
  metadata: doc.metadata,
  occurredAt: doc.occurredAt,
});

export const activityService = {
  async list(userId, filters) {
    // userId is fixed from the token before the query is built, so a filter cannot
    // widen the scope past the caller (invariant 2 and 3).
    const { items, pageInfo } = await activityRepository.listForUser({ userId, ...filters });
    return { events: items.map(toPublicEvent), pageInfo };
  },
};
