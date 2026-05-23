import { reportSnapshots } from '../../db/mongo.js';
import { producers } from '../../queues/index.js';
import { cacheAside, cacheKeys } from '../../lib/cache.js';

// Reports are generated off the request path. The API reads a snapshot; it never builds
// one, because building one means scanning a period's aggregates and that is exactly the
// work the queue exists to move out of a request.

const yesterdayIn = (timezone) => {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  local.setDate(local.getDate() - 1);
  return local.toISOString().slice(0, 10);
};

const lastMonthIn = (timezone) => {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  local.setDate(1);
  local.setMonth(local.getMonth() - 1);
  return local.toISOString().slice(0, 7);
};

const periodStartFor = (reportType, anchor) =>
  reportType === 'DAILY' ? anchor : `${anchor}-01`;

export const reportsService = {
  async get(userId, { reportType, anchor, timezone }) {
    const resolved = anchor ?? (reportType === 'DAILY' ? yesterdayIn(timezone) : lastMonthIn(timezone));
    const periodStart = periodStartFor(reportType, resolved);

    const key = cacheKeys.report(userId, reportType, periodStart);

    const { value, cached } = await cacheAside(key, async () => {
      const snapshot = await reportSnapshots().findOne(
        { userId, reportType, periodStart },
        { projection: { _id: 0 } },
      );
      return snapshot ?? null;
    });

    if (value) return { status: 'ready', report: value, cached };

    // No snapshot yet. Rather than a bare 404, the request that discovers the gap asks
    // for it to be filled - so a user hitting a report before the scheduler has run gets
    // one shortly instead of waiting until tomorrow.
    await producers.generateReport({
      userId,
      reportType,
      periodStart,
      periodEnd: reportType === 'DAILY' ? periodStart : null,
    });

    return { status: 'pending', reportType, periodStart, cached: false };
  },
};
