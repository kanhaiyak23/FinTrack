import http from 'k6/http';
import { check } from 'k6';

// Shared bootstrap: every scenario needs a user, an account and some money before it can
// measure anything. Done once in k6's setup phase so the measured iterations contain
// only the request under test.
export const bootstrap = (baseUrl) => {
  const email = `load-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const json = { headers: { 'Content-Type': 'application/json' } };

  const register = http.post(
    `${baseUrl}/auth/register`,
    JSON.stringify({ email, name: 'Load Test', password: 'correct-horse-battery' }),
    json,
  );
  check(register, { 'registered': (r) => r.status === 201 });
  const token = register.json('token');

  const auth = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };

  const account = http.post(`${baseUrl}/accounts`, JSON.stringify({ accountType: 'BROKERAGE' }), auth);
  const accountId = account.json('account.id');

  http.post(
    `${baseUrl}/transactions`,
    JSON.stringify({ type: 'DEPOSIT', accountId, amount: '10000000' }),
    auth,
  );

  // A position to report on, so the portfolio endpoint has real work rather than an
  // empty result.
  for (let i = 0; i < 10; i += 1) {
    http.post(
      `${baseUrl}/transactions`,
      JSON.stringify({ type: 'BUY', accountId, symbol: 'INFY', quantity: '1', price: '100' }),
      auth,
    );
  }

  return { token, accountId };
};
