import { prisma } from '../../db/prisma.js';
import { paginate } from '../../lib/pagination.js';

export const plansRepository = {
  create: (data) => prisma.investmentPlan.create({ data }),

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
  updateForUser: async (id, userId, data) => {
    const { count } = await prisma.investmentPlan.updateMany({ where: { id, userId }, data });
    return count === 0 ? null : prisma.investmentPlan.findUnique({ where: { id } });
  },
};
