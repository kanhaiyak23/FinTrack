// Queue names and the event routing table, with no side effects. Importing this does
// NOT open a Redis connection or construct a Queue, which matters because routing is
// something tests and tooling legitimately want to read without standing up a queue.
// index.js builds the actual Queue objects from these names.

export const QUEUE_NAMES = Object.freeze({
  ANALYTICS: 'analytics',
  ACTIVITY: 'activity',
  REPORTS: 'reports',
  NOTIFICATIONS: 'notifications',
});

// Where each outbox event type is delivered. One event can fan out to several queues: a
// deposit both moves an aggregate and belongs in the user's activity history, and those
// are different jobs with different failure modes and different scaling needs. BullMQ
// scopes job ids per queue, so the same outbox row id is a legal job id in both.
//
// Event type names are owned by apps/api/src/lib/outbox.js; a type missing from this map
// is a deployment mistake, and the publisher parks the row with an error rather than
// dropping it.
export const EVENT_ROUTES = Object.freeze({
  DEPOSIT_COMPLETED: [QUEUE_NAMES.ANALYTICS, QUEUE_NAMES.ACTIVITY],
  WITHDRAWAL_COMPLETED: [QUEUE_NAMES.ANALYTICS, QUEUE_NAMES.ACTIVITY],
  TRADE_EXECUTED: [QUEUE_NAMES.ANALYTICS, QUEUE_NAMES.ACTIVITY],
  USER_REGISTERED: [QUEUE_NAMES.ACTIVITY],
  LOGIN: [QUEUE_NAMES.ACTIVITY],
  PLAN_CREATED: [QUEUE_NAMES.ACTIVITY],
  PLAN_UPDATED: [QUEUE_NAMES.ACTIVITY],
  SUBSCRIPTION_CREATED: [QUEUE_NAMES.ACTIVITY],
  SUBSCRIPTION_CANCELLED: [QUEUE_NAMES.ACTIVITY],
});
