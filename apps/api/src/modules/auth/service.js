import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { config } from '../../config/index.js';
import { ApiError } from '../../middleware/errors.js';
import { signAccessToken } from '../../lib/jwt.js';
import { usersRepository } from '../users/repository.js';
import { toPublicUser } from '../users/service.js';

// A bcrypt comparison against a throwaway hash, used when no user exists. Without it
// the "unknown email" path returns measurably faster than "wrong password", which
// leaks which emails are registered regardless of the identical error message.
const DUMMY_HASH = bcrypt.hashSync('timing-equalisation-placeholder', config.BCRYPT_ROUNDS);

export const authService = {
  async register({ email, name, password }) {
    const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);

    let user;
    try {
      user = await usersRepository.create({ email, name, passwordHash });
    } catch (err) {
      // Rely on the unique constraint rather than a check-then-insert, which races
      // two concurrent registrations of the same address.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict('An account with that email already exists');
      }
      throw err;
    }

    return { user: toPublicUser(user), token: signAccessToken(user.id) };
  },

  async login({ email, password }) {
    const user = await usersRepository.findByEmail(email);
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

    // One message for both failures: distinguishing them enumerates accounts.
    if (!user || !matches) throw ApiError.unauthorized('Invalid email or password');

    return { user: toPublicUser(user), token: signAccessToken(user.id) };
  },
};
