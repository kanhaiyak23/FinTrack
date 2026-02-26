import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateQuery, validateParams } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { createPlanSchema, updatePlanSchema, listPlansSchema, planIdSchema } from './schema.js';
import { plansController } from './controller.js';

export const plansRouter = Router();

plansRouter.use(requireAuth);

plansRouter.post('/', validateBody(createPlanSchema), asyncHandler(plansController.create));
plansRouter.get('/', validateQuery(listPlansSchema), asyncHandler(plansController.list));
plansRouter.patch(
  '/:id',
  validateParams(planIdSchema),
  validateBody(updatePlanSchema),
  asyncHandler(plansController.update),
);
