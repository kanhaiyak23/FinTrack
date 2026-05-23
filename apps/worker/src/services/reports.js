import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { activityEvents } from '../db/mongo.js';
import { config } from '../config.js';

// Reports are derived artifacts, never a source of truth: every figure here is
// recomputed from daily_user_aggregates, which is itself derived from transactions. A
// snapshot can always be regenerated, and regenerating must produce the same numbers.

const ZERO = new Prisma.Decimal(0);
const sum = (rows, field) => rows.reduce((acc, r) => acc.plus(r[field]), ZERO);

// Period boundaries are calendar dates in REPORT_TIMEZONE, matching how the worker
// buckets daily aggregates (ADR-011). Both ends are inclusive, which is what a human
// means by "the report for September".
export const periodFor = (reportType, anchor) => {
  const [y, m, d] = anchor.split('-').map(Number);
  if (reportType === 'DAILY') {
    return { periodStart: `${anchor}`, periodEnd: `${anchor}` };
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  void d;
  return { periodStart: `${y}-${pad(m)}-01`, periodEnd: `${y}-${pad(m)}-${pad(lastDay)}` };
};

export const buildReport = async ({ userId, reportType, periodStart, periodEnd }) => {
  const [rows, activePlans, activityCount, holdings] = await Promise.all([
    prisma.dailyUserAggregate.findMany({
      where: { userId, day: { gte: new Date(periodStart), lte: new Date(periodEnd) } },
      orderBy: { day: 'asc' },
    }),
    prisma.investmentPlan.count({ where: { userId, status: 'ACTIVE' } }),
    // The one figure that comes from MongoDB rather than Postgres, because the activity
    // log is the only place that knows about non-financial events like logins.
    activityEvents().countDocuments({
      userId,
      occurredAt: { $gte: new Date(`${periodStart}T00:00:00Z`), $lte: new Date(`${periodEnd}T23:59:59.999Z`) },
    }),
    prisma.portfolioHolding.findMany({ where: { account: { userId } } }),
  ]);

  const buyValue = sum(rows, 'buyValue');
  const sellValue = sum(rows, 'sellValue');

  return {
    transactionCount: rows.reduce((acc, r) => acc + r.transactionCount, 0),
    tradingVolume: buyValue.plus(sellValue).toFixed(4),
    deposits: sum(rows, 'deposits').toFixed(4),
    withdrawals: sum(rows, 'withdrawals').toFixed(4),
    buyValue: buyValue.toFixed(4),
    sellValue: sellValue.toFixed(4),
    realizedPnl: sum(rows, 'realizedPnl').toFixed(4),
    activeInvestmentPlans: activePlans,
    activityEvents: activityCount,
    // Days on which something happened, not days elapsed - a user who traded on two
    // days of a thirty-day month has two active days.
    activeDays: rows.length,
    openPositions: holdings.filter((h) => !new Prisma.Decimal(h.quantity).isZero()).length,
    timezone: config.REPORT_TIMEZONE,
  };
};
