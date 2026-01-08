import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { ApiError } from './errors.js';

export const requireAuth = (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'Missing or malformed Authorization header'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.sub;
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired token'));
  }
};
