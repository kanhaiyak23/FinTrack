import pino from 'pino';
import { config } from './index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { instance: config.INSTANCE_ID },
  // Credentials must never reach the log pipeline. Invariant 'Conventions' in CLAUDE.md.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.body.password',
      'req.body.passwordHash',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  transport: config.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
