import { accountsService } from './service.js';

export const accountsController = {
  async create(req, res) {
    const account = await accountsService.create(req.user.userId, req.body);
    res.status(201).json({ account });
  },

  async list(req, res) {
    const result = await accountsService.list(req.user.userId, req.query);
    res.json(result);
  },

  async getById(req, res) {
    const account = await accountsService.getById(req.params.id, req.user.userId);
    res.json({ account });
  },
};
