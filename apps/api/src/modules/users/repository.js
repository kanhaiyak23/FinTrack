import { prisma } from '../../db/prisma.js';

export const usersRepository = {
  create: ({ email, name, passwordHash }) =>
    prisma.user.create({ data: { email, name, passwordHash } }),

  findByEmail: (email) => prisma.user.findUnique({ where: { email } }),

  findById: (id) => prisma.user.findUnique({ where: { id } }),
};
