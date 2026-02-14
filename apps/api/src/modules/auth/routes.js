import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { registerSchema, loginSchema } from './schema.js';
import { authController } from './controller.js';

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), asyncHandler(authController.register));
authRouter.post('/login', validateBody(loginSchema), asyncHandler(authController.login));
