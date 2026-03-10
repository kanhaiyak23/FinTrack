// Events are written through this helper inside the SAME transaction as the business
// change they describe (ADR-005). Never call a queue directly from a service: a commit
// that succeeds while the enqueue fails loses the event silently, and an enqueue that
// succeeds while the commit rolls back publishes an event for something that never
// happened. The outbox makes both impossible because the event and the change share
// one commit.
export const recordEvent = (tx, { eventType, entityType, entityId, userId, payload }) =>
  tx.outboxEvent.create({
    data: { eventType, entityType, entityId, userId, payload },
  });

export const EVENT_TYPES = {
  DEPOSIT_COMPLETED: 'DEPOSIT_COMPLETED',
  WITHDRAWAL_COMPLETED: 'WITHDRAWAL_COMPLETED',
  TRADE_EXECUTED: 'TRADE_EXECUTED',
};
