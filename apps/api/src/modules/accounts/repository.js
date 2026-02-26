import { prisma } from '../../db/prisma.js';
import { paginate } from '../../lib/pagination.js';

// Every method takes userId and scopes on it. There is deliberately no findById
// without an owner - a caller cannot accidentally fetch someone else's account
// because the unscoped method does not exist (CLAUDE.md invariant 3).
export const accountsRepository = {
  create: ({ userId, accountType, currency }) =>
    prisma.account.create({ data: { userId, accountType, currency } }),

  findByIdForUser: (id, userId) => prisma.account.findFirst({ where: { id, userId } }),

  listForUser: ({ userId, limit, cursor }) =>
    paginate({
      limit,
      cursor,
      sortField: 'createdAt',
      findMany: ({ take, where, orderBy }) =>
        prisma.account.findMany({ take, orderBy, where: { ...where, userId } }),
    }),
};
