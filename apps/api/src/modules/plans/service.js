import { plansRepository } from './repository.js';
import { ApiError } from '../../middleware/errors.js';
import { toMoneyString, toDecimal } from '../../lib/money.js';

export const toPublicPlan = (plan) => ({
  id: plan.id,
  name: plan.name,
  planType: plan.planType,
  amount: toMoneyString(plan.amount),
  frequency: plan.frequency,
  status: plan.status,
  startDate: plan.startDate,
  createdAt: plan.createdAt,
});

export const plansService = {
  async create(userId, input) {
    const plan = await plansRepository.create({
      userId,
      ...input,
      amount: toDecimal(input.amount),
    });
    return toPublicPlan(plan);
  },

  async list(userId, { limit, cursor, status }) {
    const { items, pageInfo } = await plansRepository.listForUser({ userId, limit, cursor, status });
    return { plans: items.map(toPublicPlan), pageInfo };
  },

  async update(id, userId, patch) {
    const data = { ...patch };
    if (patch.amount !== undefined) data.amount = toDecimal(patch.amount);

    const plan = await plansRepository.updateForUser(id, userId, data);
    if (!plan) throw ApiError.notFound('Plan not found');
    return toPublicPlan(plan);
  },
};
