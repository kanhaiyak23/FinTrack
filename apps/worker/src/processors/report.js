import { logger } from '../logger.js';
import { prisma } from '../db/prisma.js';
import { reportSnapshots } from '../db/mongo.js';
import { cacheRedis } from '../db/redis.js';
import { buildReport, periodFor } from '../services/reports.js';
import { anchorForNow } from '../schedule.js';
import { queues } from '../queues/index.js';
import { QUEUE_NAMES } from '../queues/routes.js';
import { JOB_NAMES } from '../queues/jobs.js';

// Generating a report is an upsert, not an insert: a report for a user, a type and a
// period is one document, and regenerating it must replace the figures rather than
// accumulate versions. That is also what makes this job safe to run twice - it needs no
// processed_events entry, because the second run computes the same numbers from the same
// source data and writes them to the same key.
const generate = async ({ userId, reportType, periodStart, periodEnd }) => {
  const metrics = await buildReport({ userId, reportType, periodStart, periodEnd });

  await reportSnapshots().updateOne(
    { userId, reportType, periodStart },
    {
      $set: { userId, reportType, periodStart, periodEnd, metrics, generatedAt: new Date() },
    },
    { upsert: true },
  );

  // The cached copy, if any, is now wrong. A failed invalidation is TTL-bounded
  // staleness, not corruption, so it must not fail the job (ADR-009).
  await cacheRedis
    .del(`report:user:${userId}:${reportType.toLowerCase()}:${periodStart}`)
    .catch((err) => logger.warn({ err: err.message }, 'report cache invalidation failed'));

  logger.info({ userId, reportType, periodStart }, 'report snapshot generated');
  return { generated: true, metrics };
};

// The scheduled job does not generate anything itself - it fans out one job per user.
// Doing the work inline would mean one long job whose failure loses every user's report;
// as separate jobs, one user's failure retries on its own and the rest are unaffected.
const scheduleAll = async ({ reportType, anchor }) => {
  // Resolved at run time unless a caller pinned it, so a worker that has been up for a
  // week still reports on yesterday rather than on the day it started.
  const { periodStart, periodEnd } = periodFor(reportType, anchor ?? anchorForNow(reportType));

  // Only users who did something in the period. Generating empty reports for dormant
  // accounts costs queue depth and tells nobody anything.
  const active = await prisma.dailyUserAggregate.findMany({
    where: { day: { gte: new Date(periodStart), lte: new Date(periodEnd) } },
    select: { userId: true },
    distinct: ['userId'],
  });

  for (const { userId } of active) {
    await queues[QUEUE_NAMES.REPORTS].add(
      JOB_NAMES.GENERATE_REPORT,
      { userId, reportType, periodStart, periodEnd },
    );
  }

  logger.info({ reportType, periodStart, periodEnd, users: active.length }, 'report jobs scheduled');
  return { scheduled: active.length };
};

export const reportProcessor = async (job) => {
  if (job.name === JOB_NAMES.SCHEDULE_REPORTS) return scheduleAll(job.data);
  return generate(job.data);
};
