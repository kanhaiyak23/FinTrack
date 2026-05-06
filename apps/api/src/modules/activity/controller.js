import { activityService } from './service.js';

export const activityController = {
  async list(req, res) {
    res.json(await activityService.list(req.user.userId, req.query));
  },
};
