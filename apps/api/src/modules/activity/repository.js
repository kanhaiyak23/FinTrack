import { activityEvents } from '../../db/mongo.js';
import { encodeCursor, decodeCursor } from '../../lib/pagination.js';

// Keyset pagination again, for the same reasons as the SQL side: skip/limit in MongoDB
// walks and discards the skipped documents, and a document inserted mid-scroll shifts
// every later page. The anchor is (occurredAt, eventId) because occurredAt alone is not
// unique - several events can share a millisecond.
export const activityRepository = {
  listForUser: async ({ userId, limit, cursor, eventType, from, to }) => {
    const filter = { userId };
    if (eventType) filter.eventType = eventType;
    if (from || to) {
      filter.occurredAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    }

    if (cursor) {
      const { value, id } = decodeCursor(cursor);
      const at = new Date(value);
      // Strictly older, or the same instant with a smaller id - the tie-break that
      // stops a shared timestamp from hiding or repeating a document.
      filter.$or = [{ occurredAt: { $lt: at } }, { occurredAt: at, eventId: { $lt: id } }];
    }

    const docs = await activityEvents()
      .find(filter, { projection: { _id: 0 } })
      .sort({ occurredAt: -1, eventId: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page.at(-1);

    return {
      items: page,
      pageInfo: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.eventId) : null,
        count: page.length,
      },
    };
  },
};
