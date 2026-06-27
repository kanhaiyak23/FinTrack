import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { bootstrap } from './setup.js';

// Analytics reads: the path the Redis cache exists for. Almost every iteration should be
// a cache hit, so this measures the cached path plus HTTP and Nginx overhead.

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const cacheHits = new Rate('cache_hit_rate');

export const options = {
  scenarios: {
    read_heavy: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    // Deliberately a regression guard, not a target claim. If a change makes cached
    // analytics slower than this, the run fails and says so.
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export const setup = () => bootstrap(BASE);

export default function (data) {
  const params = { headers: { Authorization: `Bearer ${data.token}` } };

  const res = http.get(`${BASE}/analytics/portfolio`, params);
  check(res, { 'portfolio 200': (r) => r.status === 200 });
  cacheHits.add(res.headers['X-Cache'] === 'HIT');

  const pnl = http.get(`${BASE}/analytics/pnl`, params);
  check(pnl, { 'pnl 200': (r) => r.status === 200 });
}
