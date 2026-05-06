import { z } from 'zod';

export const listActivitySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  eventType: z
    .enum([
      'USER_REGISTERED', 'LOGIN',
      'DEPOSIT_COMPLETED', 'WITHDRAWAL_COMPLETED', 'TRADE_EXECUTED',
      'PLAN_CREATED', 'PLAN_UPDATED',
      'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_CANCELLED',
    ])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
