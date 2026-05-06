import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { listActivitySchema } from './schema.js';
import { activityController } from './controller.js';

export const activityRouter = Router();

activityRouter.use(requireAuth);
activityRouter.get('/', validateQuery(listActivitySchema), asyncHandler(activityController.list));
