import { Router } from 'express';
import { checkPostgres } from '../../db/prisma.js';
import { checkMongo } from '../../db/mongo.js';
import { checkRedis } from '../../db/redis.js';
import { config } from '../../config/index.js';

export const healthRouter = Router();

const msSince = (startedAt) => Number(process.hrtime.bigint() - startedAt) / 1e6;

const probe = async (name, fn) => {
  const startedAt = process.hrtime.bigint();
  try {
    await fn();
    return { name, status: 'up', latencyMs: msSince(startedAt) };
  } catch (err) {
    return { name, status: 'down', latencyMs: msSince(startedAt), error: err.message };
  }
};

healthRouter.get('/health', async (_req, res) => {
  const checks = await Promise.all([
    probe('postgres', checkPostgres),
    probe('mongodb', checkMongo),
    probe('redis', checkRedis),
  ]);

  const byName = Object.fromEntries(checks.map(({ name, ...rest }) => [name, rest]));

  // Postgres is the source of truth: without it the API cannot serve correct data.
  // Redis and Mongo degrade rather than fail, so they do not flip the overall status.
  const healthy = byName.postgres.status === 'up';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    instance: config.INSTANCE_ID,
    uptimeSeconds: Math.round(process.uptime()),
    checks: byName,
  });
});
