import { z } from 'zod';

const decimalString = (places, label) =>
  z
    .union([z.string(), z.number()])
    .refine(
      (v) => new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(String(v)) && Number(v) > 0,
      `${label} must be positive with at most ${places} decimal places`,
    )
    .transform(String);

const accountId = z.string().uuid('must be a valid account id');
const occurredAt = z.coerce.date().optional();

// A discriminated union rather than one schema with optional everything: it makes the
// cash/trade split explicit, so a DEPOSIT carrying a symbol is rejected at the boundary
// with a clear message instead of reaching the database's CHECK constraint.
//
// These variants are .strict(), unlike the auth schemas which silently strip unknown
// keys. The difference is deliberate: an unexpected field on a registration is noise to
// discard, but an unexpected field on a money movement means the client believes it is
// doing something the server is not about to do. Ignoring it would let a caller think
// it had placed a trade when it had made a deposit.
export const createTransactionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('DEPOSIT'),
    accountId,
    amount: decimalString(4, 'amount'),
    occurredAt,
  }).strict(),
  z.object({
    type: z.literal('WITHDRAWAL'),
    accountId,
    amount: decimalString(4, 'amount'),
    occurredAt,
  }).strict(),
  z.object({
    type: z.literal('BUY'),
    accountId,
    symbol: z.string().trim().toUpperCase().min(1).max(20),
    quantity: decimalString(8, 'quantity'),
    price: decimalString(4, 'price'),
    occurredAt,
  }).strict(),
  z.object({
    type: z.literal('SELL'),
    accountId,
    symbol: z.string().trim().toUpperCase().min(1).max(20),
    quantity: decimalString(8, 'quantity'),
    price: decimalString(4, 'price'),
    occurredAt,
  }).strict(),
]);

export const listTransactionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  accountId: accountId.optional(),
  type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL']).optional(),
  symbol: z.string().trim().toUpperCase().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const transactionIdSchema = z.object({
  id: z.string().uuid('must be a valid transaction id'),
});
