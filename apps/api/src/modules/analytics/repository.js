import { prisma } from '../../db/prisma.js';

// Reads hit the pre-aggregated tables the worker maintains, not the transaction log.
// That is the whole point of the aggregation in workstream H: an analytics request is a
// small indexed lookup rather than a scan over every transaction the user ever made.
export const analyticsRepository = {
  // Scoped through the account relation, so a holding belonging to someone else cannot
  // appear however the query is composed (invariant 3).
  holdingsForUser: (userId) =>
    prisma.portfolioHolding.findMany({
      where: { account: { userId } },
      orderBy: [{ symbol: 'asc' }],
      include: { account: { select: { id: true, accountType: true, currency: true } } },
    }),

  cashForUser: (userId) =>
    prisma.account.aggregate({ where: { userId }, _sum: { balance: true }, _count: true }),

  dailyForUser: (userId, { from, to }) =>
    prisma.dailyUserAggregate.findMany({
      where: {
        userId,
        ...(from || to ? { day: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: [{ day: 'asc' }],
    }),
};
