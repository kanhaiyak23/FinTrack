import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { prisma as apiPrisma, disconnectPostgres as disconnectApiPostgres } from '../../apps/api/src/db/prisma.js';
import { prisma, disconnectPostgres } from '../../apps/worker/src/db/prisma.js';
import { queueConnection, closeQueueConnection } from '../../apps/worker/src/queues/connection.js';
import { queues, QUEUE_NAMES, defaultJobOptions, closeQueues } from '../../apps/worker/src/queues/index.js';
import { publishBatch, startOutboxPublisher } from '../../apps/worker/src/processors/outbox.js';
import { claimEvent } from '../../apps/worker/src/services/idempotency.js';
// The API side owns the producers; the worker side owns the publisher. Both are
// exercised here because they meet on the same Redis queues.
import { producers, closeQueues as closeApiQueues } from '../../apps/api/src/queues/index.js';
import { closeQueueConnection as closeApiQueueConnection } from '../../apps/api/src/queues/connection.js';
import { resetDatabase } from '../helpers/db.js';

const analytics = queues[QUEUE_NAMES.ANALYTICS];

// Nothing consumes the analytics queue in this suite, so every published row stays in
// the waiting set - which makes "how many jobs exist" directly observable.
const waitingCount = async () => (await analytics.getJobCounts('waiting')).waiting;

const seedOutbox = async (count, { eventType = 'DEPOSIT_COMPLETED' } = {}) => {
  const base = Date.now();
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    eventType,
    entityType: 'transaction',
    entityId: randomUUID(),
    userId: randomUUID(),
    payload: { amount: '100.0000', seq: i },
    // Distinct, increasing timestamps so "ordered by occurred_at" is testable.
    occurredAt: new Date(base + i * 1000),
  }));
  await prisma.outboxEvent.createMany({ data: rows });
  return rows;
};

const countWhere = (where) => prisma.outboxEvent.count({ where });

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return false;
};

beforeEach(async () => {
  await resetDatabase();
  // Real Redis, so the previous test's jobs are really still there.
  await analytics.obliterate({ force: true });
});

afterAll(async () => {
  await Promise.allSettled([closeQueues(), closeApiQueues()]);
  await Promise.allSettled([
    disconnectPostgres(),
    disconnectApiPostgres(),
    closeQueueConnection(),
    closeApiQueueConnection(),
  ]);
});

describe('outbox publisher', () => {
  test('publishes an unpublished row exactly once and marks it', async () => {
    const [row] = await seedOutbox(1);

    expect(await publishBatch()).toEqual({ claimed: 1, published: 1, failed: 0 });

    const stored = await prisma.outboxEvent.findUnique({ where: { id: row.id } });
    expect(stored.publishedAt).not.toBeNull();
    expect(stored.attempts).toBe(0);
    expect(stored.lastError).toBeNull();

    // The job id is the outbox row id - that is what makes a redelivery a no-op.
    const job = await analytics.getJob(row.id);
    expect(job.name).toBe('DEPOSIT_COMPLETED');
    expect(job.data).toMatchObject({ eventId: row.id, entityId: row.entityId, userId: row.userId });

    // A published row is invisible to the next pass, so it cannot be enqueued twice.
    expect(await publishBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(await waitingCount()).toBe(1);
  });

  test('routes by event type and leaves an unroutable row for a later deploy', async () => {
    const [row] = await seedOutbox(1, { eventType: 'SOMETHING_NOBODY_MAPPED' });

    expect(await publishBatch()).toEqual({ claimed: 1, published: 0, failed: 1 });

    const stored = await prisma.outboxEvent.findUnique({ where: { id: row.id } });
    // Unpublished, counted and explained: the row waits, it is not dropped.
    expect(stored.publishedAt).toBeNull();
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toMatch(/no queue mapped for event type SOMETHING_NOBODY_MAPPED/);
    expect(await waitingCount()).toBe(0);

    // And it is retried rather than abandoned.
    expect(await publishBatch()).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect((await prisma.outboxEvent.findUnique({ where: { id: row.id } })).attempts).toBe(2);
  });

  test('one unroutable row does not hold up the rest of its batch', async () => {
    const good = await seedOutbox(3);
    const [bad] = await seedOutbox(1, { eventType: 'SOMETHING_NOBODY_MAPPED' });

    expect(await publishBatch()).toEqual({ claimed: 4, published: 3, failed: 1 });

    expect(await countWhere({ id: { in: good.map((r) => r.id) }, publishedAt: { not: null } })).toBe(3);
    expect((await prisma.outboxEvent.findUnique({ where: { id: bad.id } })).publishedAt).toBeNull();
    expect(await waitingCount()).toBe(3);
  });

  test('two concurrent passes claim disjoint rows (FOR UPDATE SKIP LOCKED)', async () => {
    await seedOutbox(20);

    const [a, b] = await Promise.all([publishBatch(), publishBatch()]);

    // The real assertion: if SKIP LOCKED were missing, one pass would block and then
    // re-read rows the other had already claimed, and the claims would sum above 20.
    expect(a.claimed + b.claimed).toBe(20);
    expect(a.published + b.published).toBe(20);
    expect(a.failed + b.failed).toBe(0);
    expect(await countWhere({ publishedAt: null })).toBe(0);
    expect(await waitingCount()).toBe(20);
  });

  test('publishes oldest first and leaves the rest of the backlog untouched', async () => {
    const rows = await seedOutbox(5);

    expect(await publishBatch({ batchSize: 2 })).toEqual({ claimed: 2, published: 2, failed: 0 });

    const published = await prisma.outboxEvent.findMany({
      where: { publishedAt: { not: null } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(published.map((r) => r.id)).toEqual([rows[0].id, rows[1].id]);
    expect(await countWhere({ publishedAt: null, attempts: 0, lastError: null })).toBe(3);

    expect((await publishBatch({ batchSize: 10 })).published).toBe(3);
    expect(await waitingCount()).toBe(5);
  });

  test('a publisher stopped mid-backlog leaves the remainder intact for the next run', async () => {
    const rows = await seedOutbox(40);

    const first = startOutboxPublisher({ batchSize: 1, pollIntervalMs: 20 });
    expect(await waitFor(() => countWhere({ publishedAt: { not: null } }).then((n) => n > 0))).toBe(true);
    await first.stop();

    const publishedAfterStop = await countWhere({ publishedAt: { not: null } });
    const remaining = await countWhere({ publishedAt: null });
    expect(publishedAfterStop + remaining).toBe(rows.length);
    // Stopping mid-backlog has to actually leave work behind for this to prove anything.
    expect(remaining).toBeGreaterThan(0);
    // Nothing half-done: no row was marked failed or partially claimed on the way out.
    expect(await countWhere({ publishedAt: null, attempts: 0, lastError: null })).toBe(remaining);
    // One job per published row and no more - stop() did not abandon an uncommitted claim.
    expect(await waitingCount()).toBe(publishedAfterStop);

    const second = startOutboxPublisher({ batchSize: 10, pollIntervalMs: 20 });
    expect(await waitFor(() => countWhere({ publishedAt: null }).then((n) => n === 0))).toBe(true);
    await second.stop();

    // Every row delivered exactly once across the restart.
    expect(await waitingCount()).toBe(rows.length);
  });
});

describe('queue behaviour', () => {
  test('the same jobId added twice yields one job', async () => {
    const jobId = randomUUID();

    const first = await analytics.add('DEPOSIT_COMPLETED', { attempt: 'first' }, { jobId });
    const second = await analytics.add('DEPOSIT_COMPLETED', { attempt: 'second' }, { jobId });

    expect(second.id).toBe(first.id);
    expect(await waitingCount()).toBe(1);
    // The duplicate is discarded, not merged: the original payload survives.
    expect((await analytics.getJob(jobId)).data).toEqual({ attempt: 'first' });
  });

  test('a job that keeps throwing exhausts its retries and lands in the failed set', async () => {
    // An isolated queue: the shared ones must not have a consumer attached while the
    // outbox tests are counting waiting jobs.
    const name = `test-retry-${randomUUID().slice(0, 8)}`;
    const queue = new Queue(name, { connection: queueConnection, defaultJobOptions });
    let runs = 0;
    const worker = new Worker(
      name,
      async () => { runs += 1; throw new Error('processor exploded'); },
      { connection: queueConnection, concurrency: 1 },
    );

    try {
      await queue.add('always-fails', { any: 'payload' });

      expect(await waitFor(() => queue.getFailedCount().then((n) => n === 1), 15_000)).toBe(true);
      // attempts: 3 with exponential backoff - the job ran three times, not once.
      expect(runs).toBe(defaultJobOptions.attempts);

      const [failed] = await queue.getFailed();
      // It is still there to be inspected and retried; a failure is not a deletion.
      expect(failed.failedReason).toMatch(/processor exploded/);
      expect(failed.attemptsMade).toBe(defaultJobOptions.attempts);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

describe('idempotency ledger', () => {
  test('the same event claimed twice is processed once', async () => {
    const eventId = randomUUID();

    const first = await prisma.$transaction((tx) => claimEvent(tx, { eventId, processor: 'analytics' }));
    const second = await prisma.$transaction((tx) => claimEvent(tx, { eventId, processor: 'analytics' }));
    // A different processor legitimately handles the same event.
    const other = await prisma.$transaction((tx) => claimEvent(tx, { eventId, processor: 'reports' }));

    expect([first, second, other]).toEqual([true, false, true]);
    expect(await prisma.processedEvent.count({ where: { eventId } })).toBe(2);
  });

  test('a claim rolled back with its aggregate update leaves no trace', async () => {
    const eventId = randomUUID();

    await expect(
      prisma.$transaction(async (tx) => {
        await claimEvent(tx, { eventId, processor: 'analytics' });
        throw new Error('aggregate update failed');
      }),
    ).rejects.toThrow('aggregate update failed');

    // The event was never applied, so it must still be claimable.
    expect(await prisma.processedEvent.count({ where: { eventId } })).toBe(0);
  });
});

// Added during review of the workstream G implementation. The producers were written
// with custom job ids and nothing called them, so two runtime faults sat undetected.
describe('producers (regression cover)', () => {
  const drain = async (queue) => {
    await queue.drain(true).catch(() => {});
  };

  test('every producer can actually enqueue - no illegal job id', async () => {
    // BullMQ throws `Custom Id cannot contain :` for an id with a colon that does not
    // split into exactly three parts. The original `report:a:b:c:d` id did exactly that.
    const accountId = randomUUID();

    await expect(
      producers.recomputeAnalytics({ userId: randomUUID(), accountId, reason: 'test' }),
    ).resolves.toBeDefined();

    await expect(
      producers.generateReport({
        userId: randomUUID(),
        accountId,
        reportType: 'DAILY',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-01',
      }),
    ).resolves.toBeDefined();

    await expect(
      producers.sendNotification({
        userId: randomUUID(),
        channel: 'email',
        template: 'welcome',
        data: {},
      }),
    ).resolves.toBeDefined();

    await Promise.all(Object.values(queues).map(drain));
  });

  test('a second recompute request for the same account is not swallowed', async () => {
    // With a fixed per-account job id, the first request completes, is retained by
    // removeOnComplete, and every later request for that account silently returns the
    // finished job instead of queueing work.
    const accountId = randomUUID();
    const userId = randomUUID();

    const first = await producers.recomputeAnalytics({ userId, accountId, reason: 'one' });
    const second = await producers.recomputeAnalytics({ userId, accountId, reason: 'two' });

    expect(second.id).not.toBe(first.id);
    expect(second.data.reason).toBe('two');

    await drain(queues[QUEUE_NAMES.ANALYTICS]);
  });
});
