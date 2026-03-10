import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateQuery, validateParams } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import {
  createTransactionSchema,
  listTransactionsSchema,
  transactionIdSchema,
} from './schema.js';
import { transactionsController } from './controller.js';

export const transactionsRouter = Router();

transactionsRouter.use(requireAuth);

transactionsRouter.post(
  '/',
  validateBody(createTransactionSchema),
  asyncHandler(transactionsController.create),
);
transactionsRouter.get('/', validateQuery(listTransactionsSchema), asyncHandler(transactionsController.list));
transactionsRouter.get(
  '/:id',
  validateParams(transactionIdSchema),
  asyncHandler(transactionsController.getById),
);
