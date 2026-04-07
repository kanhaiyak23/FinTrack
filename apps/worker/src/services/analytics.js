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

  const [row] = await tx.$queryRaw`
    SELECT quantity, total_cost, realized_pnl
    FROM portfolio_holdings
    WHERE account_id = ${accountId}::uuid AND symbol = ${symbol}
    FOR UPDATE`;

  return {
    quantity: new Prisma.Decimal(row.quantity),
    totalCost: new Prisma.Decimal(row.total_cost),
    realizedPnl: new Prisma.Decimal(row.realized_pnl),
  };
};

// Returns the realised P&L of this event, which the daily aggregate also needs.
const applyTrade = async (tx, { accountId, symbol, type, quantity, price }) => {
  const held = await lockHolding(tx, accountId, symbol);
  const qty = new Prisma.Decimal(quantity);
  const unitPrice = new Prisma.Decimal(price);

  let next;
  let realized = ZERO;

  if (type === 'BUY') {
    next = {
      quantity: held.quantity.plus(qty),
      totalCost: held.totalCost.plus(qty.mul(unitPrice)),
      realizedPnl: held.realizedPnl,
    };
  } else {
    // The API rejects overselling before the transaction is written, so a SELL beyond
    // the holding means the aggregate has drifted from `transactions`. Clamping would
    // hide that; better to let the job fail and be visible in the failed set.
    if (qty.greaterThan(held.quantity)) {
      throw new Error(
        `aggregate drift: SELL ${qty} of ${symbol} exceeds holding ${held.quantity} on account ${accountId}`,
      );
    }

    const average = held.quantity.isZero() ? ZERO : held.totalCost.div(held.quantity);
    realized = unitPrice.minus(average).mul(qty);

    const remaining = held.quantity.minus(qty);
    next = {
      quantity: remaining,
      // Exactly zero once the position is closed, rather than a rounding residue that
      // would make the next average subtly wrong.
      totalCost: remaining.isZero() ? ZERO : held.totalCost.minus(average.mul(qty)),
      realizedPnl: held.realizedPnl.plus(realized),
    };
  }

  await tx.portfolioHolding.update({
    where: { accountId_symbol: { accountId, symbol } },
    data: {
      quantity: next.quantity,
      totalCost: next.totalCost.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
      realizedPnl: next.realizedPnl.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
    },
  });

  return realized.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
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
      type: payload.type,
      quantity: payload.quantity,
      price: payload.price,
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
