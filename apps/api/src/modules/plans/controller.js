import { plansService } from './service.js';

export const plansController = {
  async create(req, res) {
    const plan = await plansService.create(req.user.userId, req.body);
    res.status(201).json({ plan });
  },

  async list(req, res) {
    res.json(await plansService.list(req.user.userId, req.query));
  },

  async update(req, res) {
    const plan = await plansService.update(req.params.id, req.user.userId, req.body);
    res.json({ plan });
  },
};
