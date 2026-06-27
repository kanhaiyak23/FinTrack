import http from 'k6/http';
import { check } from 'k6';
import { bootstrap } from './setup.js';

// Walks the whole demo flow once. Not a performance test - it answers "is the stack
// actually wired up" before a longer run is worth starting.

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate==1.0'] } };

export const setup = () => bootstrap(BASE);

export default function (data) {
  const params = { headers: { Authorization: `Bearer ${data.token}` } };

  check(http.get(`${BASE}/health`), { 'health ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/users/me`, params), { 'me ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/accounts`, params), { 'accounts ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/transactions`, params), { 'transactions ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/analytics/portfolio`, params), { 'portfolio ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/analytics/pnl`, params), { 'pnl ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/analytics/activity`, params), { 'activity analytics ok': (r) => r.status === 200 });
  check(http.get(`${BASE}/activity`, params), { 'activity ok': (r) => r.status === 200 });
  // 202 is a correct answer here: the report has not been generated yet.
  check(http.get(`${BASE}/reports/daily`, params), { 'daily report ok': (r) => [200, 202].includes(r.status) });
}
