import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { config } from '../../config/index.js';
import { ApiError } from '../../middleware/errors.js';
import { signAccessToken } from '../../lib/jwt.js';
import { prisma } from '../../db/prisma.js';
import { recordEvent, EVENT_TYPES } from '../../lib/outbox.js';
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
      // The user row and its activity event commit together, same as every other write
      // (invariant 6). A registration that is not in the history did not happen.
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { email, name, passwordHash } });
        await recordEvent(tx, {
          eventType: EVENT_TYPES.USER_REGISTERED,
          entityType: 'user',
          entityId: created.id,
          userId: created.id,
          payload: { email: created.email, name: created.name },
        });
        return created;
      });
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

    // A login writes nothing else, so this is the whole transaction. It is still routed
    // through the outbox rather than enqueued directly, because a second mechanism for
    // emitting events is a second mechanism that can be wrong.
    await prisma.$transaction((tx) =>
      recordEvent(tx, {
        eventType: EVENT_TYPES.LOGIN,
        entityType: 'user',
        entityId: user.id,
        userId: user.id,
        payload: { email: user.email },
      }),
    );

    return { user: toPublicUser(user), token: signAccessToken(user.id) };
  },
};
