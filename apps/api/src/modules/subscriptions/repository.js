import { prisma } from '../../db/prisma.js';
import { paginate } from '../../lib/pagination.js';
import { recordEvent, EVENT_TYPES } from '../../lib/outbox.js';

export const subscriptionsRepository = {
  create: ({ userId, planId }) =>
    prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.create({ data: { userId, planId } });
      await recordEvent(tx, {
        eventType: EVENT_TYPES.SUBSCRIPTION_CREATED,
        entityType: 'subscription',
        entityId: subscription.id,
        userId,
        payload: { planId },
      });
      return subscription;
    }),

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

  cancelForUser: (id, userId) =>
    prisma.$transaction(async (tx) => {
      // Guarded on status as well as ownership so cancelling twice affects zero rows
      // rather than overwriting the original ended_at with a later timestamp. It also
      // means a second cancel emits no event, so the history shows one cancellation.
      const { count } = await tx.subscription.updateMany({
        where: { id, userId, status: 'ACTIVE' },
        data: { status: 'CANCELLED', endedAt: new Date() },
      });
      if (count === 0) return null;

      const subscription = await tx.subscription.findUnique({ where: { id } });
      await recordEvent(tx, {
        eventType: EVENT_TYPES.SUBSCRIPTION_CANCELLED,
        entityType: 'subscription',
        entityId: subscription.id,
        userId,
        payload: { planId: subscription.planId },
      });
      return subscription;
    }),
};
