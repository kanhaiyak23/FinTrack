import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('must be a valid email address'),
  name: z.string().trim().min(1, 'is required').max(120),
  password: z
    .string()
    .min(8, 'must be at least 8 characters')
    // bcrypt silently truncates beyond 72 bytes, so reject rather than mislead.
    .max(72, 'must be at most 72 characters'),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('must be a valid email address'),
  password: z.string().min(1, 'is required'),
});
