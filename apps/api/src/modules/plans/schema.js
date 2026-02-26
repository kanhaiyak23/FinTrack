import { z } from 'zod';

const money = z
  .union([z.string(), z.number()])
  .refine((v) => /^\d+(\.\d{1,4})?$/.test(String(v)), 'must be a positive amount with at most 4 decimal places');

export const createPlanSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  planType: z.enum(['SIP', 'LUMPSUM', 'RECURRING']),
  amount: money,
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY']),
  startDate: z.coerce.date(),
});

// PATCH is a partial update, so every field is optional - but an empty body is a
// client bug rather than a no-op, and saying so is more useful than a silent 200.
export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    amount: money.optional(),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY']).optional(),
    status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be supplied');

export const listPlansSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
});

export const planIdSchema = z.object({ id: z.string().uuid('must be a valid plan id') });
