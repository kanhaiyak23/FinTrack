import { z } from 'zod';

export const createAccountSchema = z.object({
  accountType: z.enum(['CHECKING', 'SAVINGS', 'BROKERAGE']),
  currency: z.string().trim().toUpperCase().length(3).default('INR'),
});

export const accountIdSchema = z.object({
  id: z.string().uuid('must be a valid account id'),
});
