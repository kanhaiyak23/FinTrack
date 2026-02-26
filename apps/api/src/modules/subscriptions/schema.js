import { z } from 'zod';

export const createSubscriptionSchema = z.object({
  planId: z.string().uuid('must be a valid plan id'),
});

export const listSubscriptionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
});

export const subscriptionIdSchema = z.object({
  id: z.string().uuid('must be a valid subscription id'),
});
