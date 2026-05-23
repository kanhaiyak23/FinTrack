import { reportsService } from './service.js';
import { config } from '../../config/index.js';

const respond = (res, result) => {
  res.set('x-cache', result.cached ? 'HIT' : 'MISS');

  if (result.status === 'ready') return res.json({ report: result.report });

  // 202 rather than 404: the resource is not missing, it has not been produced yet, and
  // asking again shortly is the correct client behaviour.
  res.status(202).set('retry-after', '10').json({
    status: 'pending',
    message: 'Report is being generated asynchronously. Retry shortly.',
    reportType: result.reportType,
    periodStart: result.periodStart,
  });
};

export const reportsController = {
  async daily(req, res) {
    respond(res, await reportsService.get(req.user.userId, {
      reportType: 'DAILY', anchor: req.query.date, timezone: config.REPORT_TIMEZONE,
    }));
  },

  async monthly(req, res) {
    respond(res, await reportsService.get(req.user.userId, {
      reportType: 'MONTHLY', anchor: req.query.month, timezone: config.REPORT_TIMEZONE,
    }));
  },
};
