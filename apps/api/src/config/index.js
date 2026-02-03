import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// .env lives at the repo root, but processes start from their workspace directory
// (and from / inside Docker, where the environment is injected instead). Resolving
// relative to this file makes both cases work without a cwd assumption.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// ENV_FILE overrides the default location: containers inject the environment
// directly, and tests point it at a path that does not exist to get a clean slate.
const envFile = process.env.ENV_FILE ?? path.join(repoRoot, '.env');
dotenv.config({ path: envFile, quiet: true });

// Fail fast and loudly: a process that starts with a missing secret is worse than
// one that refuses to start. Every value the app needs is declared here.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MONGODB_URL: z.string().min(1, 'MONGODB_URL is required'),
  MONGODB_DB: z.string().default('fintrack'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // Report period boundaries are computed in this zone; storage stays UTC. ADR-011.
  REPORT_TIMEZONE: z.string().default('Asia/Kolkata'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Identifies which instance served a request once several sit behind Nginx.
  INSTANCE_ID: z.string().default('api-local'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});
