import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

// Mirrored from apps/worker/src/queues/jobs.js rather than imported across the workspace
// boundary, for the same reason the queue names are: the two processes ship
// independently, and apps/api reaching into apps/worker would make that untrue. These
// strings are the wire contract, so they are literals on both sides.
export const JOB_NAMES = Object.freeze({
  RECOMPUTE_ANALYTICS: 'recompute-analytics',
  GENERATE_REPORT: 'generate-report',
  SCHEDULE_REPORTS: 'schedule-reports',
  SEND_NOTIFICATION: 'send-notification',
});

// Producers only. `Worker` is never imported in apps/api: an API instance that
// processed a job would stop being interchangeable with its siblings behind Nginx
// (CLAUDE.md invariant 9) and would compete with the worker fleet for the same jobs.
//
// Note also what does NOT belong here: a business event. Those go through the outbox
// inside the write's transaction (invariant 6, ADR-005). These helpers are for work a
// request asks for but does not itself perform - an on-demand report, a notification -
// where losing the job on a crash costs a retry, not correctness.

export const QUEUE_NAMES = Object.freeze({
  ANALYTICS: 'analytics',
  ACTIVITY: 'activity',
  REPORTS: 'reports',
  NOTIFICATIONS: 'notifications',
});

export const defaultJobOptions = Object.freeze({
  attempts: 3,
  // Exponential from 1s: 1s, 2s, 4s. Long enough for a restarting dependency to come
  // back, short enough that a transient failure does not delay analytics by minutes.
  backoff: { type: 'exponential', delay: 1000 },
  // Completed jobs are kept briefly rather than removed immediately, because BullMQ
  // deduplicates by jobId only while the job still exists. That window is what makes a
  // redelivered outbox row a no-op; processed_events (ADR-008) is the durable backstop
  // once the window closes.
  removeOnComplete: { age: 3600, count: 1000 },
  // Failures are kept far longer than successes. A job nobody can see is a job nobody
  // will fix, and the failed set is the only record of what the retries could not do.
  removeOnFail: { age: 86_400, count: 5000 },
});

// Queues are built on demand for the same reason the connection is: importing this
// module must not open a socket. `queueFor` is the only way to reach one.
const instances = new Map();

const queueFor = (name) => {
  let queue = instances.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: getQueueConnection(), defaultJobOptions });
    instances.set(name, queue);
  }
  return queue;
};

// Named producers rather than raw `queue.add` at the call site: the payload shape is
// declared once here, so a processor in apps/worker has exactly one contract to read.
//
// None of these sets a custom jobId, and both reasons are load-bearing:
//
//  1. BullMQ rejects a custom id containing ':' unless it splits into exactly three
//     parts - a compatibility carve-out for repeatable jobs. `report:a:b:c:d` throws
//     `Custom Id cannot contain :` at runtime, which no unit test of the queue module
//     would catch because nothing calls the producer until it is wired up.
//
//  2. More importantly, a fixed id does not mean "collapse duplicates" once the job has
//     run. defaultJobOptions retains completed jobs for an hour, and `add` with the id
//     of a RETAINED COMPLETED job is silently ignored - it returns that finished job and
//     queues nothing. A per-account recompute id would therefore recompute an account at
//     most once an hour and drop every request in between, with no error anywhere.
//     Verified against BullMQ 5.x: second add returned state 'completed' with the first
//     call's payload and a waiting count of zero.
//
// Deduplication here would need a window that expires with the work, not with the
// retention policy. It is deliberately left out until workstream I has a real
// requirement for it; correctness of the processor comes from processed_events
// (ADR-008), which does not depend on the queue collapsing anything.
export const producers = {
  // userId always comes from req.user.userId, never from the request (invariant 2).
  recomputeAnalytics: ({ userId, accountId, reason }) =>
    queueFor(QUEUE_NAMES.ANALYTICS).add(JOB_NAMES.RECOMPUTE_ANALYTICS, { userId, accountId, reason }),

  generateReport: ({ userId, accountId, reportType, periodStart, periodEnd }) =>
    queueFor(QUEUE_NAMES.REPORTS).add(JOB_NAMES.GENERATE_REPORT, {
      userId,
      accountId,
      reportType,
      periodStart,
      periodEnd,
    }),

  sendNotification: ({ userId, channel, template, data }) =>
    queueFor(QUEUE_NAMES.NOTIFICATIONS).add(JOB_NAMES.SEND_NOTIFICATION, {
      userId,
      channel,
      template,
      data,
    }),
};

export const closeQueues = async () => {
  const open = [...instances.values()];
  instances.clear();
  await Promise.allSettled(open.map((queue) => queue.close()));
};
