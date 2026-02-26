import { subscriptionsService } from './service.js';

export const subscriptionsController = {
  async create(req, res) {
    const subscription = await subscriptionsService.create(req.user.userId, req.body);
    res.status(201).json({ subscription });
  },

  async list(req, res) {
    res.json(await subscriptionsService.list(req.user.userId, req.query));
  },

  async cancel(req, res) {
    const subscription = await subscriptionsService.cancel(req.params.id, req.user.userId);
    res.json({ subscription });
  },
};
