import { randomUUID } from 'node:crypto';
import { prisma, disconnectPostgres } from '../../apps/worker/src/db/prisma.js';
import { closeQueueConnection } from '../../apps/worker/src/queues/connection.js';
// The analytics processor invalidates the cache, which opens a second Redis connection.
// Leaving it open keeps the jest process alive after the suite finishes.
import { disconnectCacheRedis } from '../../apps/worker/src/db/redis.js';
import { closeQueues } from '../../apps/worker/src/queues/index.js';
import { analyticsProcessor } from '../../apps/worker/src/processors/analytics.js';
import { applyEvent } from '../../apps/worker/src/services/analytics.js';
import { resetDatabase } from '../helpers/db.js';

// The processors are exercised directly rather than through a live BullMQ Worker. What
// is under test is what a delivery DOES to the aggregates - redelivery, ordering,
// arithmetic - and driving them directly makes "deliver this exact event twice" a
// statement rather than a race to arrange. The queue wiring itself is covered in
// queues.test.js.

let userId;
let accountId;

const makeJob = (event) => ({ id: event.eventId, name: event.eventType, data: event });

// The analytics processor recomputes a holding by replaying that symbol's trades from
// the transaction log, so a trade event is only meaningful alongside the row it
// describes. Writing the transaction first is what the API does, and what the test must
// do too - an event with no transaction behind it is not a case the system can produce.
const tradeEvent = async ({ type, symbol, quantity, price, at = new Date() }) => {
  const amount = (Number(quantity) * Number(price)).toFixed(4);
  const transaction = await prisma.transaction.create({
    data: {
      accountId,
      type,
      symbol,
      quantity: String(quantity),
      price: String(price),
      amount,
      transactionTime: at,
      status: 'COMPLETED',
    },
  });

  return {
    eventId: randomUUID(),
    eventType: 'TRADE_EXECUTED',
    entityType: 'transaction',
    entityId: transaction.id,
    userId,
    payload: {
      accountId, type, symbol, quantity: String(quantity), price: String(price),
      amount, transactionId: transaction.id, transactionTime: at.toISOString(),
    },
  };
};

const cashEvent = ({ type, amount, at = new Date() }) => ({
  eventId: randomUUID(),
  eventType: type === 'DEPOSIT' ? 'DEPOSIT_COMPLETED' : 'WITHDRAWAL_COMPLETED',
  entityType: 'transaction',
  entityId: randomUUID(),
  userId,
  payload: { accountId, type, amount: String(amount), transactionTime: at.toISOString() },
});

const holding = (symbol) =>
  prisma.portfolioHolding.findUnique({ where: { accountId_symbol: { accountId, symbol } } });

const dailyRows = () => prisma.dailyUserAggregate.findMany({ where: { userId } });

beforeEach(async () => {
  await resetDatabase();
  const user = await prisma.user.create({
    data: { email: `worker-${randomUUID()}@example.com`, name: 'W', passwordHash: 'x' },
  });
  userId = user.id;
  const account = await prisma.account.create({
    data: { userId, accountType: 'BROKERAGE', balance: '1000000.0000' },
  });
  accountId = account.id;
});

afterAll(async () => {
  await closeQueues();
  await Promise.allSettled([disconnectPostgres(), closeQueueConnection(), disconnectCacheRedis()]);
});

describe('idempotency', () => {
  test('processing the same event twice leaves the aggregates identical', async () => {
    const event = cashEvent({ type: 'DEPOSIT', amount: '5000.00' });

    const first = await analyticsProcessor(makeJob(event));
    const afterFirst = await dailyRows();

    const second = await analyticsProcessor(makeJob(event));
    const afterSecond = await dailyRows();

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond[0].deposits.toFixed(4)).toBe('5000.0000');
    expect(afterSecond[0].transactionCount).toBe(1);
  });

  test('a trade redelivered does not double the holding', async () => {
    const event = await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '100' });

    await analyticsProcessor(makeJob(event));
    await analyticsProcessor(makeJob(event));
    await analyticsProcessor(makeJob(event));

    const h = await holding('INFY');
    expect(h.quantity.toFixed(8)).toBe('10.00000000');
    expect(h.totalCost.toFixed(4)).toBe('1000.0000');
  });

  test('two distinct events with identical payloads both apply', async () => {
    // Idempotency keys on the EVENT, not on its content: two genuine deposits of the
    // same amount are two deposits.
    await analyticsProcessor(makeJob(cashEvent({ type: 'DEPOSIT', amount: '100' })));
    await analyticsProcessor(makeJob(cashEvent({ type: 'DEPOSIT', amount: '100' })));

    const [row] = await dailyRows();
    expect(row.deposits.toFixed(4)).toBe('200.0000');
    expect(row.transactionCount).toBe(2);
  });

  test('a failure mid-apply leaves the event unclaimed, so a retry can succeed', async () => {
    // A SELL whose replay finds no prior BUY throws inside the transaction. The claim
    // must roll back with it, or the retry would be skipped as "already processed" and
    // the aggregate would never be applied at all.
    const sellAt = new Date('2026-06-02T10:00:00Z');
    const bad = await tradeEvent({ type: 'SELL', symbol: 'TCS', quantity: '5', price: '100', at: sellAt });

    await expect(analyticsProcessor(makeJob(bad))).rejects.toThrow(/aggregate drift/);
    expect(await prisma.processedEvent.count({ where: { eventId: bad.eventId } })).toBe(0);

    // The missing BUY arrives, dated BEFORE the sale - which is what the replay orders
    // by. The same event now applies cleanly, which is the point: a failed job stays
    // retryable rather than being marked done.
    await tradeEvent({ type: 'BUY', symbol: 'TCS', quantity: '10', price: '90', at: new Date('2026-06-01T10:00:00Z') });
    await expect(analyticsProcessor(makeJob(bad))).resolves.toMatchObject({ applied: true });
  });

  test('different processors claim the same event independently', async () => {
    const event = cashEvent({ type: 'DEPOSIT', amount: '10' });
    await analyticsProcessor(makeJob(event));

    // The ledger is keyed on (eventId, processor), so a second consumer of the same
    // event is not blocked by the first having handled it.
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.processedEvent.createMany({
        data: [{ eventId: event.eventId, processor: 'some-other-consumer' }],
        skipDuplicates: true,
      });
      expect(count).toBe(1);
    });
  });
});

describe('weighted-average cost basis', () => {
  const apply = (event) => prisma.$transaction((tx) => applyEvent(tx, event));

  test('averages across buys at different prices', async () => {
    await apply(await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '100' }));
    await apply(await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '200' }));

    const h = await holding('INFY');
    // 20 units, 3000 total cost -> average 150
    expect(h.quantity.toFixed(8)).toBe('20.00000000');
    expect(h.totalCost.toFixed(4)).toBe('3000.0000');
  });

  test('a sell realises (price - average) x quantity and reduces the basis', async () => {
    await apply(await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '100' }));
    await apply(await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '200' }));
    // average 150, sell 5 at 250 -> realised 500, basis drops by 5 * 150 = 750
    await apply(await tradeEvent({ type: 'SELL', symbol: 'INFY', quantity: '5', price: '250' }));

    const h = await holding('INFY');
    expect(h.quantity.toFixed(8)).toBe('15.00000000');
    expect(h.totalCost.toFixed(4)).toBe('2250.0000');
    expect(h.realizedPnl.toFixed(4)).toBe('500.0000');
  });

  test('a sale at the average price realises nothing', async () => {
    await apply(await tradeEvent({ type: 'BUY', symbol: 'TCS', quantity: '4', price: '250' }));
    await apply(await tradeEvent({ type: 'SELL', symbol: 'TCS', quantity: '2', price: '250' }));

    const h = await holding('TCS');
    expect(h.realizedPnl.toFixed(4)).toBe('0.0000');
  });

  test('a loss is realised as a negative number, not clamped', async () => {
    await apply(await tradeEvent({ type: 'BUY', symbol: 'WIPRO', quantity: '10', price: '500' }));
    await apply(await tradeEvent({ type: 'SELL', symbol: 'WIPRO', quantity: '10', price: '400' }));

    const h = await holding('WIPRO');
    expect(h.realizedPnl.toFixed(4)).toBe('-1000.0000');
  });

  test('closing a position leaves the basis at exactly zero', async () => {
    // Three buys at a price that does not divide evenly, so a rounding residue would
    // show up here and corrupt the average of whatever is bought next.
    await apply(await tradeEvent({ type: 'BUY', symbol: 'HDFC', quantity: '3', price: '100.3333' }));
    await apply(await tradeEvent({ type: 'SELL', symbol: 'HDFC', quantity: '3', price: '120' }));

    const h = await holding('HDFC');
    expect(h.quantity.toFixed(8)).toBe('0.00000000');
    expect(h.totalCost.toFixed(4)).toBe('0.0000');
  });

  test('buying again after closing starts from a clean average', async () => {
    await apply(await tradeEvent({ type: 'BUY', symbol: 'ITC', quantity: '5', price: '400' }));
    await apply(await tradeEvent({ type: 'SELL', symbol: 'ITC', quantity: '5', price: '450' }));
    await apply(await tradeEvent({ type: 'BUY', symbol: 'ITC', quantity: '2', price: '100' }));

    const h = await holding('ITC');
    expect(h.totalCost.toFixed(4)).toBe('200.0000');
    expect(h.realizedPnl.toFixed(4)).toBe('250.0000');
  });

  test('holdings are tracked per symbol', async () => {
    await apply(await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '1', price: '100' }));
    await apply(await tradeEvent({ type: 'BUY', symbol: 'TCS', quantity: '2', price: '200' }));

    expect((await holding('INFY')).quantity.toFixed(8)).toBe('1.00000000');
    expect((await holding('TCS')).quantity.toFixed(8)).toBe('2.00000000');
  });
});

describe('daily aggregates', () => {
  const apply = (event) => prisma.$transaction((tx) => applyEvent(tx, event));

  test('accumulates every transaction type into one row per day', async () => {
    const at = new Date('2026-09-15T06:00:00Z');
    await apply(cashEvent({ type: 'DEPOSIT', amount: '10000', at }));
    await apply(cashEvent({ type: 'WITHDRAWAL', amount: '1500', at }));
    await apply(await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '100', at }));
    await apply(await tradeEvent({ type: 'SELL', symbol: 'INFY', quantity: '5', price: '150', at }));

    const rows = await dailyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].deposits.toFixed(4)).toBe('10000.0000');
    expect(rows[0].withdrawals.toFixed(4)).toBe('1500.0000');
    expect(rows[0].buyValue.toFixed(4)).toBe('1000.0000');
    expect(rows[0].sellValue.toFixed(4)).toBe('750.0000');
    expect(rows[0].realizedPnl.toFixed(4)).toBe('250.0000');
    expect(rows[0].transactionCount).toBe(4);
  });

  test('separates days', async () => {
    await apply(cashEvent({ type: 'DEPOSIT', amount: '100', at: new Date('2026-09-15T06:00:00Z') }));
    await apply(cashEvent({ type: 'DEPOSIT', amount: '200', at: new Date('2026-09-16T06:00:00Z') }));

    expect(await dailyRows()).toHaveLength(2);
  });

  test('day boundaries follow REPORT_TIMEZONE, not UTC', async () => {
    // 20:00 UTC on the 15th is 01:30 on the 16th in Asia/Kolkata (UTC+5:30). Bucketing
    // by UTC would put these on different days; by report timezone they are the same.
    await apply(cashEvent({ type: 'DEPOSIT', amount: '100', at: new Date('2026-09-15T20:00:00Z') }));
    await apply(cashEvent({ type: 'DEPOSIT', amount: '200', at: new Date('2026-09-15T21:00:00Z') }));

    const rows = await dailyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].day.toISOString().slice(0, 10)).toBe('2026-09-16');
    expect(rows[0].deposits.toFixed(4)).toBe('300.0000');
  });
});

describe('out-of-order delivery', () => {
  const apply = (event) => prisma.$transaction((tx) => applyEvent(tx, event));

  // The bug this guards against: weighted average is order dependent, and the worker
  // processes jobs concurrently. Three trades on one account are claimed together and
  // then race for the holding row lock - which serialises the writes without ordering
  // them. Applying them incrementally produced a plausible, wrong average; recomputing
  // from the transaction log cannot.
  test('events applied in reverse order produce the correct final state', async () => {
    const day = (d) => new Date(`2026-06-0${d}T10:00:00Z`);

    const buyLow = await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '100', at: day(1) });
    const buyHigh = await tradeEvent({ type: 'BUY', symbol: 'INFY', quantity: '10', price: '200', at: day(2) });
    const sell = await tradeEvent({ type: 'SELL', symbol: 'INFY', quantity: '5', price: '250', at: day(3) });

    // Deliberately backwards: the sale first, then the purchases that funded it.
    await apply(sell);
    await apply(buyHigh);
    await apply(buyLow);

    const h = await holding('INFY');
    // Average of 10@100 and 10@200 is 150. Selling 5 at 250 realises 500 and leaves
    // 15 units at a basis of 2250. Applying the sale first would give 2500 and 750.
    expect(h.quantity.toFixed(8)).toBe('15.00000000');
    expect(h.totalCost.toFixed(4)).toBe('2250.0000');
    expect(h.realizedPnl.toFixed(4)).toBe('500.0000');
  });

  test('a late event heals the aggregate rather than corrupting it', async () => {
    const buy = await tradeEvent({ type: 'BUY', symbol: 'TCS', quantity: '4', price: '100', at: new Date('2026-06-01T10:00:00Z') });
    await apply(buy);
    expect((await holding('TCS')).quantity.toFixed(8)).toBe('4.00000000');

    // A second purchase that was written earlier but processed later.
    const earlier = await tradeEvent({ type: 'BUY', symbol: 'TCS', quantity: '6', price: '50', at: new Date('2026-05-30T10:00:00Z') });
    await apply(earlier);

    const h = await holding('TCS');
    expect(h.quantity.toFixed(8)).toBe('10.00000000');
    expect(h.totalCost.toFixed(4)).toBe('700.0000');
  });
});
