import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateQuery, validateParams } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { paginationSchema } from '../../lib/pagination.js';
import { createAccountSchema, accountIdSchema } from './schema.js';
import { accountsController } from './controller.js';

export const accountsRouter = Router();

accountsRouter.use(requireAuth);

accountsRouter.post('/', validateBody(createAccountSchema), asyncHandler(accountsController.create));
accountsRouter.get('/', validateQuery(paginationSchema), asyncHandler(accountsController.list));
accountsRouter.get('/:id', validateParams(accountIdSchema), asyncHandler(accountsController.getById));
