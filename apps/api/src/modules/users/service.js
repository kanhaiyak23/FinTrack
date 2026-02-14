import { usersRepository } from './repository.js';
import { ApiError } from '../../middleware/errors.js';

// Never return passwordHash past this boundary.
export const toPublicUser = ({ id, email, name, createdAt }) => ({ id, email, name, createdAt });

export const usersService = {
  async getById(userId) {
    const user = await usersRepository.findById(userId);
    // A valid token for a deleted user is authentication without a subject.
    if (!user) throw ApiError.notFound('User not found');
    return toPublicUser(user);
  },
};
