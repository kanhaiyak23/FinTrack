import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../middleware/errors.js';
import { toMoneyString, toQuantityString } from '../../lib/money.js';
import { recordEvent, EVENT_TYPES } from '../../lib/outbox.js';
import { transactionsRepository as repo } from './repository.js';

const CREDITS = new Set(['DEPOSIT', 'SELL']);
const TRADES = new Set(['BUY', 'SELL']);

export const toPublicTransaction = (t) => ({
  id: t.id,
  accountId: t.accountId,
  type: t.type,
  symbol: t.symbol,
  quantity: toQuantityString(t.quantity),
  price: toMoneyString(t.price),
  amount: toMoneyString(t.amount),
  status: t.status,
  transactionTime: t.transactionTime,
  idempotencyKey: t.idempotencyKey ?? undefined,
});

const eventTypeFor = (type) =>
  TRADES.has(type) ? EVENT_TYPES.TRADE_EXECUTED : EVENT_TYPES[`${type}_COMPLETED`];

// For a trade the cash moved is quantity * price, computed here rather than taken from
// the client: a client that sends a mismatched amount would otherwise decide its own
// price. For a deposit or withdrawal the client's amount IS the operation.
const cashAmountFor = (input) =>
  TRADES.has(input.type)
    ? new Prisma.Decimal(input.quantity).mul(input.price)
    : new Prisma.Decimal(input.amount);

export const transactionsService = {
  async create(userId, input, idempotencyKey) {
    const result = await prisma.$transaction(async (tx) => {
      // Ownership and the lock in one statement: a row that is not yours does not
      // come back, so there is nothing to act on.
      const account = await repo.lockAccount(tx, input.accountId, userId);
      if (!account) throw ApiError.notFound('Account not found');

      // Checked inside the lock, so two concurrent retries of the same key serialise
      // and the second sees the first's row rather than writing a duplicate.
      if (idempotencyKey) {
        const existing = await repo.findByIdempotencyKey(tx, input.accountId, idempotencyKey);
        if (existing) return { transaction: existing, replayed: true };
      }

      const amount = cashAmountFor(input);
      const balance = new Prisma.Decimal(account.balance);

      if (!CREDITS.has(input.type) && amount.greaterThan(balance)) {
        throw ApiError.validation('Insufficient funds', [
          `available ${balance.toFixed(4)}, required ${amount.toFixed(4)}`,
        ]);
      }

      if (input.type === 'SELL') {
        // No short selling: the position has to exist before it can be sold.
        const holding = await repo.holdingFor(tx, input.accountId, input.symbol);
        const quantity = new Prisma.Decimal(input.quantity);
        if (quantity.greaterThan(holding)) {
          throw ApiError.validation('Insufficient holdings', [
            `${input.symbol}: holding ${holding.toFixed(8)}, attempted to sell ${quantity.toFixed(8)}`,
          ]);
        }
      }

      const transaction = await repo.insert(tx, {
        accountId: input.accountId,
        type: input.type,
        symbol: input.symbol ?? null,
        quantity: TRADES.has(input.type) ? new Prisma.Decimal(input.quantity) : null,
        price: TRADES.has(input.type) ? new Prisma.Decimal(input.price) : null,
        amount,
        status: 'COMPLETED',
        idempotencyKey: idempotencyKey ?? null,
        ...(input.occurredAt ? { transactionTime: input.occurredAt } : {}),
      });

      const delta = CREDITS.has(input.type) ? amount : amount.negated();
      await repo.adjustBalance(tx, input.accountId, delta);

      // Same commit as the balance change and the transaction row. If anything after
      // this throws, all three disappear together.
      await recordEvent(tx, {
        eventType: eventTypeFor(input.type),
        entityType: 'transaction',
        entityId: transaction.id,
        userId,
        payload: {
          transactionId: transaction.id,
          accountId: input.accountId,
          type: input.type,
          symbol: transaction.symbol,
          quantity: transaction.quantity?.toString() ?? null,
          price: transaction.price?.toString() ?? null,
          amount: amount.toString(),
          transactionTime: transaction.transactionTime.toISOString(),
        },
      });

      return { transaction, replayed: false };
    });

    return { transaction: toPublicTransaction(result.transaction), replayed: result.replayed };
  },

  // Used to resolve an idempotency-key race: the loser of the unique index looks up
  // the winner's row and returns that instead of failing.
  async findByKey(userId, accountId, idempotencyKey) {
    const transaction = await prisma.transaction.findFirst({
      where: { accountId, idempotencyKey, account: { userId } },
    });
    return transaction ? toPublicTransaction(transaction) : null;
  },

  async getById(id, userId) {
    const transaction = await repo.findByIdForUser(id, userId);
    if (!transaction) throw ApiError.notFound('Transaction not found');
    return toPublicTransaction(transaction);
  },

  async list(userId, filters) {
    const { items, pageInfo } = await repo.listForUser({ userId, ...filters });
    return { transactions: items.map(toPublicTransaction), pageInfo };
  },
};
