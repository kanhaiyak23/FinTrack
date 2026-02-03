import express from 'express';
import { healthRouter } from './modules/health/routes.js';
import { requestId, httpLogger } from './middleware/requestContext.js';
import { notFound, errorHandler } from './middleware/errors.js';

export const createApp = () => {
  const app = express();

  // Behind Nginx, so client IPs arrive via X-Forwarded-For.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(httpLogger);
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);

  // Feature modules mount here as workstreams B-J land.

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
