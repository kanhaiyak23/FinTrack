import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { usersService } from './service.js';

export const usersRouter = Router();

usersRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Identity comes from the token, never from the request (invariant 2).
    const user = await usersService.getById(req.user.userId);
    res.json({ user });
  }),
);
