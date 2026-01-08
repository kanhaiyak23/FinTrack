import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { usersRepo } from '../models/store.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const publicUser = ({ id, email, name, createdAt }) => ({ id, email, name, createdAt });

const signToken = (user) =>
  jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

authRouter.post(
  '/register',
  validateBody([
    { field: 'email', type: 'string', required: true },
    { field: 'name', type: 'string', required: true },
    { field: 'password', type: 'string', required: true, minLength: 8 },
  ]),
  async (req, res, next) => {
    try {
      const { email, name, password } = req.body;
      if (usersRepo.findByEmail(email)) {
        throw new ApiError(409, 'An account with that email already exists');
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = usersRepo.create({ email, name, passwordHash });
      res.status(201).json({ user: publicUser(user), token: signToken(user) });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/login',
  validateBody([
    { field: 'email', type: 'string', required: true },
    { field: 'password', type: 'string', required: true },
  ]),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const user = usersRepo.findByEmail(email);
      // Same error either way so the response cannot be used to enumerate emails.
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        throw new ApiError(401, 'Invalid email or password');
      }
      res.json({ user: publicUser(user), token: signToken(user) });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.get('/me', requireAuth, (req, res, next) => {
  const user = usersRepo.findById(req.userId);
  if (!user) return next(new ApiError(404, 'User not found'));
  res.json({ user: publicUser(user) });
});
