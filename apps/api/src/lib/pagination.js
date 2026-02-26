import { z } from 'zod';
import { ApiError } from '../middleware/errors.js';

export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  cursor: z.string().optional(),
});

// Keyset (cursor) pagination rather than OFFSET. OFFSET makes the database walk and
// discard every skipped row, so page 5000 costs 5000 pages of work; and a row inserted
// mid-scroll shifts every subsequent page, duplicating or skipping records. A cursor
// anchored on (sortField, id) is stable under concurrent writes and costs the same at
// any depth, because the index seeks straight to the anchor.
export const encodeCursor = (value, id) =>
  Buffer.from(JSON.stringify({ v: value instanceof Date ? value.toISOString() : value, id })).toString('base64url');

export const decodeCursor = (cursor) => {
  try {
    const { v, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!v || !id) throw new Error('incomplete cursor');
    return { value: v, id };
  } catch {
    throw ApiError.badRequest('Malformed pagination cursor');
  }
};

// Fetches limit + 1 rows to learn whether another page exists without a second query.
export const paginate = async ({ limit, cursor, sortField, findMany }) => {
  const decoded = cursor ? decodeCursor(cursor) : null;

  const rows = await findMany({
    take: limit + 1,
    where: decoded
      ? {
          OR: [
            { [sortField]: { lt: decoded.value } },
            { [sortField]: decoded.value, id: { lt: decoded.id } },
          ],
        }
      : undefined,
    orderBy: [{ [sortField]: 'desc' }, { id: 'desc' }],
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page,
    pageInfo: {
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last[sortField], last.id) : null,
      count: page.length,
    },
  };
};
