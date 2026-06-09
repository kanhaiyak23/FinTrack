import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// See apps/api/src/config/index.js - same reasoning, one directory shallower.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// ENV_FILE overrides the default location: containers inject the environment
// directly, and tests point it at a path that does not exist to get a clean slate.
const envFile = process.env.ENV_FILE ?? path.join(repoRoot, '.env');
dotenv.config({ path: envFile, quiet: true });

// The worker needs a narrower slice of the environment than the API: no HTTP port,
// no JWT secret. Declaring it separately keeps the processes independently deployable.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MONGODB_URL: z.string().min(1, 'MONGODB_URL is required'),
  MONGODB_DB: z.string().default('fintrack'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REPORT_TIMEZONE: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Defaults to the hostname, which Docker sets to the container id - so scaled
  // replicas identify themselves without compose having to invent a value per replica.
  INSTANCE_ID: z.string().default(`worker-${os.hostname()}`),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid worker environment configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
});
