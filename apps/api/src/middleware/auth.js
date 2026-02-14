import { verifyAccessToken } from '../lib/jwt.js';
import { ApiError } from './errors.js';

// Sets req.user from the bearer token. This is the ONLY place identity enters the
// system: no controller may read a user id from a body, query or header
// (CLAUDE.md invariant 2).
export const requireAuth = (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('Missing or malformed Authorization header'));
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.sub };
    next();
  } catch (err) {
    // Distinguish expiry from tampering for the client; both are still 401.
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    next(ApiError.unauthorized(message));
  }
};
