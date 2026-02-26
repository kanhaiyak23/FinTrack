import { Prisma } from '@prisma/client';
import { subscriptionsRepository } from './repository.js';
import { plansRepository } from '../plans/repository.js';
import { ApiError } from '../../middleware/errors.js';

export const toPublicSubscription = (subscription) => ({
  id: subscription.id,
  planId: subscription.planId,
  plan: subscription.plan ?? undefined,
  status: subscription.status,
  startedAt: subscription.startedAt,
  endedAt: subscription.endedAt,
});

export const subscriptionsService = {
  async create(userId, { planId }) {
    // Cross-module reads go through the other module's repository via its owner-scoped
    // method, so subscribing to another user's plan is not possible.
    const plan = await plansRepository.findByIdForUser(planId, userId);
    if (!plan) throw ApiError.notFound('Plan not found');
    if (plan.status === 'CANCELLED') {
      throw ApiError.conflict('Cannot subscribe to a cancelled plan');
    }

    try {
      const subscription = await subscriptionsRepository.create({ userId, planId });
      return toPublicSubscription(subscription);
    } catch (err) {
      // uq_subscriptions_one_active_per_plan. Relying on the partial unique index
      // rather than a prior SELECT keeps two concurrent subscribes from both passing.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict('Already subscribed to this plan');
      }
      throw err;
    }
  },

  async list(userId, { limit, cursor, status }) {
    const { items, pageInfo } = await subscriptionsRepository.listForUser({
      userId,
      limit,
      cursor,
      status,
    });
    return { subscriptions: items.map(toPublicSubscription), pageInfo };
  },

  async cancel(id, userId) {
    const subscription = await subscriptionsRepository.cancelForUser(id, userId);
    if (!subscription) throw ApiError.notFound('Active subscription not found');
    return toPublicSubscription(subscription);
  },
};
