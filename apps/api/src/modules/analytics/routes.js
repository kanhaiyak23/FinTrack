import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { activityRangeSchema } from './schema.js';
import { analyticsController } from './controller.js';

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

analyticsRouter.get('/portfolio', asyncHandler(analyticsController.portfolio));
analyticsRouter.get('/activity', validateQuery(activityRangeSchema), asyncHandler(analyticsController.activity));
analyticsRouter.get('/pnl', asyncHandler(analyticsController.pnl));
