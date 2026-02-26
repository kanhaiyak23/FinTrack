import { prisma } from '../../db/prisma.js';
import { paginate } from '../../lib/pagination.js';

export const subscriptionsRepository = {
  create: ({ userId, planId }) => prisma.subscription.create({ data: { userId, planId } }),

  listForUser: ({ userId, limit, cursor, status }) =>
    paginate({
      limit,
      cursor,
      sortField: 'startedAt',
      findMany: ({ take, where, orderBy }) =>
        prisma.subscription.findMany({
          take,
          orderBy,
          where: { ...where, userId, ...(status ? { status } : {}) },
          include: { plan: { select: { id: true, name: true, planType: true } } },
        }),
    }),

  cancelForUser: async (id, userId) => {
    // Guarded on status as well as ownership so cancelling twice affects zero rows
    // rather than overwriting the original ended_at with a later timestamp.
    const { count } = await prisma.subscription.updateMany({
      where: { id, userId, status: 'ACTIVE' },
      data: { status: 'CANCELLED', endedAt: new Date() },
    });
    return count === 0 ? null : prisma.subscription.findUnique({ where: { id } });
  },
};
