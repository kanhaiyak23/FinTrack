import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateQuery, validateParams } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { createSubscriptionSchema, listSubscriptionsSchema, subscriptionIdSchema } from './schema.js';
import { subscriptionsController } from './controller.js';

export const subscriptionsRouter = Router();

subscriptionsRouter.use(requireAuth);

subscriptionsRouter.post('/', validateBody(createSubscriptionSchema), asyncHandler(subscriptionsController.create));
subscriptionsRouter.get('/', validateQuery(listSubscriptionsSchema), asyncHandler(subscriptionsController.list));
subscriptionsRouter.delete(
  '/:id',
  validateParams(subscriptionIdSchema),
  asyncHandler(subscriptionsController.cancel),
);
