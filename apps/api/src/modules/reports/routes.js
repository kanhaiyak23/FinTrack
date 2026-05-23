import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { dailyReportSchema, monthlyReportSchema } from './schema.js';
import { reportsController } from './controller.js';

export const reportsRouter = Router();

reportsRouter.use(requireAuth);
reportsRouter.get('/daily', validateQuery(dailyReportSchema), asyncHandler(reportsController.daily));
reportsRouter.get('/monthly', validateQuery(monthlyReportSchema), asyncHandler(reportsController.monthly));
