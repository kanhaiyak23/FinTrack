import { accountsRepository } from './repository.js';
import { ApiError } from '../../middleware/errors.js';
import { toMoneyString } from '../../lib/money.js';

export const toPublicAccount = (account) => ({
  id: account.id,
  accountType: account.accountType,
  currency: account.currency,
  balance: toMoneyString(account.balance),
  createdAt: account.createdAt,
});

export const accountsService = {
  async create(userId, input) {
    const account = await accountsRepository.create({ userId, ...input });
    return toPublicAccount(account);
  },

  async list(userId, { limit, cursor }) {
    const { items, pageInfo } = await accountsRepository.listForUser({ userId, limit, cursor });
    return { accounts: items.map(toPublicAccount), pageInfo };
  },

  async getById(id, userId) {
    const account = await accountsRepository.findByIdForUser(id, userId);
    // 404 rather than 403: confirming a resource exists but is not yours still
    // discloses its existence. The API policy is that another user's rows are
    // indistinguishable from rows that do not exist.
    if (!account) throw ApiError.notFound('Account not found');
    return toPublicAccount(account);
  },
};
