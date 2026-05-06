import { prisma } from '../../db/prisma.js';
import { paginate } from '../../lib/pagination.js';
import { recordEvent, EVENT_TYPES } from '../../lib/outbox.js';

export const plansRepository = {
  // The plan and its event share one transaction (invariant 6).
  create: (data) =>
    prisma.$transaction(async (tx) => {
      const plan = await tx.investmentPlan.create({ data });
      await recordEvent(tx, {
        eventType: EVENT_TYPES.PLAN_CREATED,
        entityType: 'investment_plan',
        entityId: plan.id,
        userId: plan.userId,
        payload: {
          name: plan.name,
          planType: plan.planType,
          amount: plan.amount.toString(),
          frequency: plan.frequency,
        },
      });
      return plan;
    }),

  findByIdForUser: (id, userId) => prisma.investmentPlan.findFirst({ where: { id, userId } }),

  listForUser: ({ userId, limit, cursor, status }) =>
    paginate({
      limit,
      cursor,
      sortField: 'createdAt',
      findMany: ({ take, where, orderBy }) =>
        prisma.investmentPlan.findMany({
          take,
          orderBy,
          where: { ...where, userId, ...(status ? { status } : {}) },
        }),
    }),

  // Scoping the update by userId as well as id means a mismatched owner updates zero
  // rows instead of someone else's plan, even if the ownership check above regressed.
  updateForUser: (id, userId, data) =>
    prisma.$transaction(async (tx) => {
      const { count } = await tx.investmentPlan.updateMany({ where: { id, userId }, data });
      // No rows matched means the plan is not this user's, so there is nothing to
      // update and nothing to record.
      if (count === 0) return null;

      const plan = await tx.investmentPlan.findUnique({ where: { id } });
      await recordEvent(tx, {
        eventType: EVENT_TYPES.PLAN_UPDATED,
        entityType: 'investment_plan',
        entityId: plan.id,
        userId: plan.userId,
        // Which fields the caller actually changed, so the history shows the edit
        // rather than just the resulting state.
        payload: { changed: Object.keys(data), status: plan.status },
      });
      return plan;
    }),
};
