import express from 'express';
import { healthRouter } from './modules/health/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { accountsRouter } from './modules/accounts/routes.js';
import { plansRouter } from './modules/plans/routes.js';
import { subscriptionsRouter } from './modules/subscriptions/routes.js';
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
  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/accounts', accountsRouter);
  app.use('/plans', plansRouter);
  app.use('/subscriptions', subscriptionsRouter);

  // Remaining feature modules mount here as workstreams D-J land.

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
