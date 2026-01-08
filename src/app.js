import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { transactionsRouter } from './routes/transactions.js';
import { requireAuth } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/errors.js';

export const createApp = () => {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.use('/api/auth', authRouter);
  app.use('/api/accounts', requireAuth, accountsRouter);
  app.use('/api/transactions', requireAuth, transactionsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
