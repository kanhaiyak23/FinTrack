import { Prisma } from '@prisma/client';
import { analyticsRepository as repo } from './repository.js';
import { toMoneyString, toQuantityString } from '../../lib/money.js';
import { cacheAside, cacheKeys } from '../../lib/cache.js';

const ZERO = new Prisma.Decimal(0);
const sum = (rows, field) => rows.reduce((acc, row) => acc.plus(row[field]), ZERO);

// Average is derived on read rather than stored: it is exactly total_cost / quantity,
// and storing it would be a third number that could disagree with the other two.
const averageBuyPrice = (holding) => {
  const quantity = new Prisma.Decimal(holding.quantity);
  if (quantity.isZero()) return null;
  return new Prisma.Decimal(holding.totalCost).div(quantity).toDecimalPlaces(4).toFixed(4);
};

const buildPortfolio = async (userId) => {
  const [holdings, cash] = await Promise.all([
    repo.holdingsForUser(userId),
    repo.cashForUser(userId),
  ]);

  // A closed position keeps its row so realised P&L survives, but it is not a holding.
  const open = holdings.filter((h) => !new Prisma.Decimal(h.quantity).isZero());

  return {
    cash: {
      total: toMoneyString(cash._sum.balance ?? 0),
      accounts: cash._count,
    },
    holdings: open.map((h) => ({
      accountId: h.accountId,
      symbol: h.symbol,
      quantity: toQuantityString(h.quantity),
      averageBuyPrice: averageBuyPrice(h),
      costBasis: toMoneyString(h.totalCost),
      realizedPnl: toMoneyString(h.realizedPnl),
      currency: h.account.currency,
    })),
    totals: {
      symbols: open.length,
      costBasis: toMoneyString(sum(open, 'totalCost')),
      // Deliberately absent: market value and unrealised P&L. Both need live prices,
      // and this system has no price feed. Returning a number derived from cost basis
      // would look like a valuation while being nothing of the kind.
      marketValue: null,
      unrealizedPnl: null,
    },
  };
};

const buildActivity = async (userId, range) => {
  const rows = await repo.dailyForUser(userId, range);

  return {
    range: { from: range.from?.toISOString().slice(0, 10) ?? null, to: range.to?.toISOString().slice(0, 10) ?? null },
    totals: {
      transactionCount: rows.reduce((acc, r) => acc + r.transactionCount, 0),
      deposits: toMoneyString(sum(rows, 'deposits')),
      withdrawals: toMoneyString(sum(rows, 'withdrawals')),
      buyValue: toMoneyString(sum(rows, 'buyValue')),
      sellValue: toMoneyString(sum(rows, 'sellValue')),
      // Total volume moved through the account, which is what "transaction volume"
      // means here - stated explicitly because it is otherwise ambiguous.
      tradingVolume: toMoneyString(sum(rows, 'buyValue').plus(sum(rows, 'sellValue'))),
    },
    // Days on which anything happened. Days with no activity have no row, so this is a
    // count of active days rather than of elapsed days.
    activeDays: rows.length,
    series: rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      transactionCount: r.transactionCount,
      deposits: toMoneyString(r.deposits),
      withdrawals: toMoneyString(r.withdrawals),
      buyValue: toMoneyString(r.buyValue),
      sellValue: toMoneyString(r.sellValue),
    })),
  };
};

const buildPnl = async (userId) => {
  const holdings = await repo.holdingsForUser(userId);
  const realized = sum(holdings, 'realizedPnl');

  return {
    // One documented method, applied everywhere (ADR-006).
    method: 'WEIGHTED_AVERAGE',
    realized: {
      total: toMoneyString(realized),
      bySymbol: holdings
        .filter((h) => !new Prisma.Decimal(h.realizedPnl).isZero())
        .map((h) => ({ symbol: h.symbol, realizedPnl: toMoneyString(h.realizedPnl) })),
    },
    // Not computed rather than computed wrongly: there is no price feed, so an
    // unrealised figure would be invented.
    unrealized: null,
    unrealizedNote: 'requires a market price feed, which this system does not have',
  };
};

export const analyticsService = {
  // Portfolio and P&L are cached; their inputs only change when the worker applies an
  // event, and the worker invalidates these exact keys when it does.
  portfolio: (userId) => cacheAside(cacheKeys.portfolio(userId), () => buildPortfolio(userId)),

  pnl: (userId) => cacheAside(cacheKeys.pnl(userId), () => buildPnl(userId)),

  // Only the unfiltered view is cached. A caller-supplied date range makes the key
  // space unbounded, and caching one range under the shared activity key would serve
  // it to a request asking for a different one.
  activity: (userId, range) =>
    range.from || range.to
      ? buildActivity(userId, range).then((value) => ({ value, cached: false }))
      : cacheAside(cacheKeys.activity(userId), () => buildActivity(userId, range)),
};
