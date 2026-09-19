import { Prisma } from '@prisma/client';
import { config } from '../config.js';

// Weighted-average cost basis (ADR-006). One documented method, applied consistently:
//
//   BUY   quantity += q             total_cost += q * price
//   SELL  average    = total_cost / quantity      (before the sale)
//         realised   = (price - average) * q
//         quantity  -= q            total_cost -= average * q
//
// Reducing the basis proportionally is what makes this work without per-lot state: the
// units that remain keep the same average they had before the sale.

const ZERO = new Prisma.Decimal(0);

// Creating the row first and then locking it means the read-modify-write below cannot
// race a concurrent job for the same symbol: ON CONFLICT DO NOTHING is atomic, and the
// SELECT ... FOR UPDATE that follows always finds a row to lock.
const lockHolding = async (tx, accountId, symbol) => {
  await tx.$executeRaw`
    INSERT INTO portfolio_holdings (account_id, symbol, updated_at)
    VALUES (${accountId}::uuid, ${symbol}, now())
    ON CONFLICT (account_id, symbol) DO NOTHING`;

  await tx.$queryRaw`
    SELECT 1 FROM portfolio_holdings
    WHERE account_id = ${accountId}::uuid AND symbol = ${symbol}
    FOR UPDATE`;
};

// Weighted average is ORDER DEPENDENT: the realised P&L of a sale depends on the
// average at the moment it happened. Applying trades incrementally is therefore only
// correct if events arrive in order - and they do not. The worker runs jobs
// concurrently, so three trades on one account are claimed together and then race for
// the holding row lock. The lock serialises the writes; it does not order them. A SELL
// that wins the race against an earlier BUY produces a plausible, wrong average.
//
// So the holding is not mutated incrementally. It is RECOMPUTED by replaying that
// symbol's completed trades from the transaction log, which is the source of truth. The
// result is identical whatever order the events are processed in, and a late or
// redelivered event heals the aggregate instead of corrupting it.
//
// The cost is a query over one account's trades in one symbol, served by
// idx_transactions_account_symbol - not a scan of the transaction table.
const replaySymbol = async (tx, { accountId, symbol, forTransactionId }) => {
  const rows = await tx.$queryRaw`
    SELECT id, type, quantity, price
    FROM transactions
    WHERE account_id = ${accountId}::uuid
      AND symbol = ${symbol}
      AND type IN ('BUY', 'SELL')
      AND status = 'COMPLETED'
    -- created_at and id break ties so the replay is deterministic when two trades
    -- share a transaction_time.
    ORDER BY transaction_time ASC, created_at ASC, id ASC`;

  let quantity = ZERO;
  let totalCost = ZERO;
  let realizedPnl = ZERO;
  // What THIS event contributed, which is what the daily bucket needs. Computed during
  // the same replay so it cannot disagree with the holding.
  let realizedForEvent = ZERO;

  for (const row of rows) {
    const qty = new Prisma.Decimal(row.quantity);
    const price = new Prisma.Decimal(row.price);

    if (row.type === 'BUY') {
      quantity = quantity.plus(qty);
      totalCost = totalCost.plus(qty.mul(price));
      continue;
    }

    // The API refuses a SELL beyond the holding before it is ever written, so hitting
    // this means the transaction log itself is inconsistent - rows deleted, or a bug
    // upstream. Clamping would produce plausible numbers that are silently wrong, so the
    // job fails and lands in the failed set where it is visible.
    if (qty.greaterThan(quantity)) {
      throw new Error(
        `aggregate drift: SELL ${qty} of ${symbol} exceeds holding ${quantity} on account ${accountId}`,
      );
    }

    const average = quantity.isZero() ? ZERO : totalCost.div(quantity);
    const realized = price.minus(average).mul(qty);
    realizedPnl = realizedPnl.plus(realized);
    if (row.id === forTransactionId) realizedForEvent = realized;

    quantity = quantity.minus(qty);
    // Exactly zero once the position closes, rather than a rounding residue that would
    // make the next average subtly wrong.
    totalCost = quantity.isZero() ? ZERO : totalCost.minus(average.mul(qty));
  }

  return { quantity, totalCost, realizedPnl, realizedForEvent };
};

const applyTrade = async (tx, { accountId, symbol, transactionId }) => {
  // The lock still matters: it stops two concurrent replays of the same symbol from
  // both writing, even though they would compute the same answer.
  await lockHolding(tx, accountId, symbol);

  const state = await replaySymbol(tx, { accountId, symbol, forTransactionId: transactionId });

  await tx.portfolioHolding.update({
    where: { accountId_symbol: { accountId, symbol } },
    data: {
      quantity: state.quantity,
      totalCost: state.totalCost.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
      realizedPnl: state.realizedPnl.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
    },
  });

  return state.realizedForEvent.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
};

// Pure increments, so this is a single atomic upsert with no lock and no read. The day
// is derived in REPORT_TIMEZONE from a UTC timestamp (ADR-011), in SQL rather than in
// JavaScript so the boundary matches what a report query would compute.
const bumpDailyAggregate = async (tx, { userId, occurredAt, deltas }) => {
  await tx.$executeRaw`
    INSERT INTO daily_user_aggregates AS d (
      user_id, day, deposits, withdrawals, buy_value, sell_value,
      realized_pnl, transaction_count, updated_at
    )
    VALUES (
      ${userId}::uuid,
      (${occurredAt}::timestamptz AT TIME ZONE ${config.REPORT_TIMEZONE})::date,
      ${deltas.deposits}::numeric, ${deltas.withdrawals}::numeric,
      ${deltas.buyValue}::numeric, ${deltas.sellValue}::numeric,
      ${deltas.realizedPnl}::numeric, 1, now()
    )
    ON CONFLICT (user_id, day) DO UPDATE SET
      deposits          = d.deposits + EXCLUDED.deposits,
      withdrawals       = d.withdrawals + EXCLUDED.withdrawals,
      buy_value         = d.buy_value + EXCLUDED.buy_value,
      sell_value        = d.sell_value + EXCLUDED.sell_value,
      realized_pnl      = d.realized_pnl + EXCLUDED.realized_pnl,
      transaction_count = d.transaction_count + 1,
      updated_at        = now()`;
};

// Applies one outbox event to the aggregates. The caller supplies the transaction, and
// the idempotency claim lives in it too - so an event is marked processed only if its
// aggregate changes commit (CLAUDE.md invariant 7).
export const applyEvent = async (tx, event) => {
  const { eventType, userId, payload } = event;
  const amount = new Prisma.Decimal(payload.amount);

  const deltas = {
    deposits: '0', withdrawals: '0', buyValue: '0', sellValue: '0', realizedPnl: '0',
  };

  if (eventType === 'DEPOSIT_COMPLETED') {
    deltas.deposits = amount.toFixed(4);
  } else if (eventType === 'WITHDRAWAL_COMPLETED') {
    deltas.withdrawals = amount.toFixed(4);
  } else if (eventType === 'TRADE_EXECUTED') {
    const realized = await applyTrade(tx, {
      accountId: payload.accountId,
      symbol: payload.symbol,
      transactionId: payload.transactionId,
    });

    if (payload.type === 'BUY') deltas.buyValue = amount.toFixed(4);
    else {
      deltas.sellValue = amount.toFixed(4);
      deltas.realizedPnl = realized.toFixed(4);
    }
  } else {
    // Routed here but not understood: a deployment mistake, and failing loudly is the
    // only way it gets noticed.
    throw new Error(`analytics processor received unsupported event type ${eventType}`);
  }

  await bumpDailyAggregate(tx, { userId, occurredAt: payload.transactionTime, deltas });
};
