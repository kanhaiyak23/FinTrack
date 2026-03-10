import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { paginate } from '../../lib/pagination.js';

// Transactions carry no user_id - they reference an account, and the account carries
// the owner. Every read therefore joins through the account, which is what makes
// "another user's transaction" indistinguishable from "no such transaction".
const ownedBy = (userId) => ({ account: { userId } });

export const transactionsRepository = {
  // Locks the account row for the duration of the surrounding transaction. Without
  // this, two concurrent withdrawals both read the same balance, both decide there
  // are sufficient funds, and both commit - the classic lost update.
  lockAccount: async (tx, accountId, userId) => {
    const rows = await tx.$queryRaw`
      SELECT id, balance, currency
      FROM accounts
      WHERE id = ${accountId}::uuid AND user_id = ${userId}::uuid
      FOR UPDATE`;
    return rows[0] ?? null;
  },

  findByIdempotencyKey: (tx, accountId, idempotencyKey) =>
    tx.transaction.findFirst({ where: { accountId, idempotencyKey } }),

  // Net position in a symbol, from completed trades only. Read inside the account
  // lock so a concurrent SELL cannot race past it.
  holdingFor: async (tx, accountId, symbol) => {
    const rows = await tx.$queryRaw`
      SELECT COALESCE(SUM(
        CASE WHEN type = 'BUY' THEN quantity ELSE -quantity END
      ), 0) AS holding
      FROM transactions
      WHERE account_id = ${accountId}::uuid
        AND symbol = ${symbol}
        AND type IN ('BUY', 'SELL')
        AND status = 'COMPLETED'`;
    return new Prisma.Decimal(rows[0]?.holding ?? 0);
  },

  insert: (tx, data) => tx.transaction.create({ data }),

  // Expressed as a relative increment so the SQL is `balance = balance + $1`. The row
  // lock already serialises callers; this keeps it correct even if that ever changed.
  adjustBalance: (tx, accountId, delta) =>
    tx.account.update({ where: { id: accountId }, data: { balance: { increment: delta } } }),

  findByIdForUser: (id, userId) =>
    prisma.transaction.findFirst({ where: { id, ...ownedBy(userId) } }),

  listForUser: ({ userId, limit, cursor, accountId, type, symbol, from, to }) =>
    paginate({
      limit,
      cursor,
      sortField: 'transactionTime',
      findMany: ({ take, where, orderBy }) =>
        prisma.transaction.findMany({
          take,
          orderBy,
          where: {
            ...where,
            ...ownedBy(userId),
            ...(accountId ? { accountId } : {}),
            ...(type ? { type } : {}),
            ...(symbol ? { symbol } : {}),
            ...(from || to
              ? { transactionTime: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
              : {}),
          },
        }),
    }),
};
