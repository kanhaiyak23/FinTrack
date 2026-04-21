import { analyticsService } from './service.js';

// x-cache makes the cache observable without a debug endpoint or a log dive. It is also
// how the demo flow in the project plan shows a second identical request being served
// from Redis.
const send = (res, { value, cached }) => {
  res.set('x-cache', cached ? 'HIT' : 'MISS');
  res.json(value);
};

export const analyticsController = {
  async portfolio(req, res) {
    send(res, await analyticsService.portfolio(req.user.userId));
  },

  async activity(req, res) {
    send(res, await analyticsService.activity(req.user.userId, req.query));
  },

  async pnl(req, res) {
    send(res, await analyticsService.pnl(req.user.userId));
  },
};
