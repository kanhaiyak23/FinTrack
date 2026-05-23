// Job names, with no side effects, for the same reason routes.js exists: a producer, a
// processor and a test all need these strings, and none of them should have to construct
// a queue to read one.
export const JOB_NAMES = Object.freeze({
  RECOMPUTE_ANALYTICS: 'recompute-analytics',
  GENERATE_REPORT: 'generate-report',
  SCHEDULE_REPORTS: 'schedule-reports',
  SEND_NOTIFICATION: 'send-notification',
});
