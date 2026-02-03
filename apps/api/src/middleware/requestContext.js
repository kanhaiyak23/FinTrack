import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '../config/logger.js';
import { config } from '../config/index.js';

// Correlates log lines for one request, and survives Nginx forwarding an upstream id.
export const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] ?? randomUUID();
  res.setHeader('x-request-id', req.id);
  // Makes it visible which instance served the request once several sit behind Nginx.
  res.setHeader('x-instance-id', config.INSTANCE_ID);
  next();
};

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.id,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: { ignore: (req) => req.url === '/health' },
});
