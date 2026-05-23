import { redis } from '../db/redis.js';
import { logger } from '../config/logger.js';
import { config } from '../config/index.js';

// Cache-aside, and deliberately fail-open. Every Redis interaction here is wrapped:
// a cache that is down must cost latency, never correctness or availability
// (CLAUDE.md invariant 8). Nothing in this module is allowed to throw.
//
// PostgreSQL stays authoritative. A cache miss and a cache outage are the same thing
// from the caller's point of view - both compute from the database.

export const cacheKeys = {
  portfolio: (userId) => `analytics:user:${userId}:portfolio`,
  activity: (userId) => `analytics:user:${userId}:activity`,
  pnl: (userId) => `analytics:user:${userId}:pnl`,
  // The worker builds this exact string when it invalidates a regenerated report, so
  // the format is a contract between the two processes. It lives here and is mirrored
  // in apps/worker/src/processors/report.js.
  report: (userId, reportType, periodStart) =>
    `report:user:${userId}:${reportType.toLowerCase()}:${periodStart}`,
};

// Every analytics key for one user. Used on invalidation, where being coarse is right:
// a transaction can move the portfolio, the activity totals and the P&L at once, and a
// surplus DEL costs one recompute while a missed one serves stale money figures.
export const userAnalyticsKeys = (userId) => [
  cacheKeys.portfolio(userId),
  cacheKeys.activity(userId),
  cacheKeys.pnl(userId),
];

const readThrough = async (key) => {
  try {
    const hit = await redis.get(key);
    return hit === null ? null : JSON.parse(hit);
  } catch (err) {
    // Includes a malformed payload from an older deploy, not just an outage: either
    // way the right move is to recompute rather than serve something unparseable.
    logger.warn({ key, err: err.message }, 'cache read failed - falling through to postgres');
    return null;
  }
};

const write = async (key, value, ttlSeconds) => {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ key, err: err.message }, 'cache write failed - result still returned');
  }
};

// Returns { value, cached } so a caller can surface the hit/miss without a second
// lookup - the API reports it as an x-cache header.
export const cacheAside = async (key, compute, { ttlSeconds = config.CACHE_TTL_SECONDS } = {}) => {
  const hit = await readThrough(key);
  if (hit !== null) return { value: hit, cached: true };

  const value = await compute();
  await write(key, value, ttlSeconds);
  return { value, cached: false };
};

export const invalidate = async (keys) => {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    // The TTL is the backstop: a failed invalidation means staleness bounded by
    // CACHE_TTL_SECONDS, not permanent staleness. That is the reason the TTL exists
    // even though the worker invalidates explicitly (ADR-009).
    logger.warn({ keys, err: err.message }, 'cache invalidation failed - TTL will expire it');
  }
};
