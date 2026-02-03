import { config } from './config.js';
import { logger } from './logger.js';

// Processors and queue subscriptions arrive in workstreams G and H. This skeleton
// exists so the process, its configuration and its shutdown path are testable now.
logger.info({ instance: config.INSTANCE_ID }, 'fintrack worker starting');

const shutdown = async (signal) => {
  logger.info({ signal }, 'worker shutting down');
  // Workers close here once they exist, draining in-flight jobs first.
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

logger.info('worker ready - no processors registered yet');
