import { logger } from './logger.js';
import { config } from './config.js';
import { queues } from './queues/index.js';
import { QUEUE_NAMES } from './queues/routes.js';
import { JOB_NAMES } from './queues/jobs.js';

// BullMQ repeatable jobs rather than node-cron: the schedule then lives in Redis with
// the rest of the queue state, so it survives a restart and does not fire N times when
// N worker instances are running. node-cron would fire once per process.
//
// The cron timezone is REPORT_TIMEZONE, the same zone the daily aggregates are bucketed
// in (ADR-011), so "the daily report" covers exactly the day it is named after.
const SCHEDULES = [
  {
    name: 'daily-reports',
    reportType: 'DAILY',
    // 00:15 rather than 00:00: the outbox publisher and analytics workers need a moment
    // to drain events from the final minutes of the day, or the report misses them.
    pattern: '15 0 * * *',
    anchorFor: (now) => shiftDays(now, -1),
  },
  {
    name: 'monthly-reports',
    reportType: 'MONTHLY',
    pattern: '30 0 1 * *',
    anchorFor: (now) => shiftMonthStart(now, -1),
  },
];

const iso = (d) => d.toISOString().slice(0, 10);
const shiftDays = (now, days) => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const shiftMonthStart = (now, months) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));
  return iso(d);
};

export const scheduleReportJobs = async () => {
  const reports = queues[QUEUE_NAMES.REPORTS];

  for (const schedule of SCHEDULES) {
    await reports.add(
      JOB_NAMES.SCHEDULE_REPORTS,
      // The anchor is resolved when the job RUNS, not when it is registered, so a
      // long-running worker does not keep reporting on the day it booted.
      { reportType: schedule.reportType },
      {
        repeat: { pattern: schedule.pattern, tz: config.REPORT_TIMEZONE },
        jobId: schedule.name,
        removeOnComplete: { count: 50 },
      },
    );
  }

  logger.info(
    { schedules: SCHEDULES.map((s) => `${s.name}@${s.pattern}`), tz: config.REPORT_TIMEZONE },
    'repeatable report jobs registered',
  );
};

// Exported so the processor can resolve "which period is this run for" at run time.
export const anchorForNow = (reportType, now = new Date()) =>
  SCHEDULES.find((s) => s.reportType === reportType).anchorFor(now);
