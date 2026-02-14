import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// The token carries identity and nothing else. Email, name and role would go stale
// the moment they changed, and anything sensitive would be readable by the holder:
// a JWT payload is signed, not encrypted.
export const signAccessToken = (userId) =>
  jwt.sign({}, config.JWT_SECRET, {
    subject: userId,
    expiresIn: config.JWT_EXPIRES_IN,
    issuer: 'fintrack',
  });

export const verifyAccessToken = (token) =>
  jwt.verify(token, config.JWT_SECRET, { issuer: 'fintrack' });
