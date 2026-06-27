import http from 'k6/http';
import { check } from 'k6';
import { bootstrap } from './setup.js';

// Deposits: a real database transaction with a row lock and an outbox write on every
// iteration. This is the path that cannot be cached, and it is where the API's
// throughput ceiling actually lives.

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  scenarios: {
    write_heavy: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '30s', target: 10 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export const setup = () => bootstrap(BASE);

export default function (data) {
  const params = {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
  };

  // All VUs hit the SAME account on purpose: every iteration contends for one row lock,
  // which is the worst case and the interesting one.
  const res = http.post(
    `${BASE}/transactions`,
    JSON.stringify({ type: 'DEPOSIT', accountId: data.accountId, amount: '1.00' }),
    params,
  );

  check(res, { 'deposit 201': (r) => r.status === 201 });
}
