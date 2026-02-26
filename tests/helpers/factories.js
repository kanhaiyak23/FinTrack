import request from 'supertest';
import { uniqueEmail } from './db.js';

export const registerUser = async (app, overrides = {}) => {
  const credentials = {
    email: uniqueEmail(),
    name: 'Test User',
    password: 'correct-horse-battery',
    ...overrides,
  };
  const res = await request(app).post('/auth/register').send(credentials);
  if (res.status !== 201) throw new Error(`registration failed: ${JSON.stringify(res.body)}`);

  const auth = (req) => req.set('Authorization', `Bearer ${res.body.token}`);
  return { credentials, token: res.body.token, user: res.body.user, auth };
};

export const createAccount = async (app, auth, overrides = {}) => {
  const res = await auth(request(app).post('/accounts')).send({
    accountType: 'BROKERAGE',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`account creation failed: ${JSON.stringify(res.body)}`);
  return res.body.account;
};

export const createPlan = async (app, auth, overrides = {}) => {
  const res = await auth(request(app).post('/plans')).send({
    name: 'Monthly SIP',
    planType: 'SIP',
    amount: '5000.0000',
    frequency: 'MONTHLY',
    startDate: '2026-01-01',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`plan creation failed: ${JSON.stringify(res.body)}`);
  return res.body.plan;
};
