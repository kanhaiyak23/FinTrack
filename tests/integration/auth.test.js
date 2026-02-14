import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../apps/api/src/app.js';
import { prisma, disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { connectMongo, disconnectMongo } from '../../apps/api/src/db/mongo.js';
import { disconnectRedis } from '../../apps/api/src/db/redis.js';
import { resetDatabase, uniqueEmail } from '../helpers/db.js';

const app = createApp();

const credentials = () => ({
  email: uniqueEmail(),
  name: 'Test User',
  password: 'correct-horse-battery',
});

beforeAll(async () => {
  await connectMongo();
  await resetDatabase();
});

afterAll(async () => {
  await Promise.allSettled([disconnectPostgres(), disconnectMongo(), disconnectRedis()]);
});

describe('POST /auth/register', () => {
  test('creates a user and returns a token', async () => {
    const creds = credentials();
    const res = await request(app).post('/auth/register').send(creds);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: creds.email, name: creds.name });
    expect(res.body.token).toEqual(expect.any(String));
  });

  test('never returns the password hash', async () => {
    const res = await request(app).post('/auth/register').send(credentials());
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
  });

  test('stores the password hashed, not in plaintext', async () => {
    const creds = credentials();
    await request(app).post('/auth/register').send(creds);

    const stored = await prisma.user.findUnique({ where: { email: creds.email } });
    expect(stored.passwordHash).not.toBe(creds.password);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  test('rejects a duplicate email with 409', async () => {
    const creds = credentials();
    await request(app).post('/auth/register').send(creds);
    const res = await request(app).post('/auth/register').send(creds);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already exists/i);
  });

  test('treats email as case-insensitive when detecting duplicates', async () => {
    const creds = credentials();
    await request(app).post('/auth/register').send(creds);
    const res = await request(app)
      .post('/auth/register')
      .send({ ...creds, email: creds.email.toUpperCase() });

    expect(res.status).toBe(409);
  });

  test('rejects a short password with 422 and says why', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ ...credentials(), password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.details.join(' ')).toMatch(/at least 8 characters/);
  });

  test('rejects a malformed email with 422', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ ...credentials(), email: 'not-an-email' });

    expect(res.status).toBe(422);
  });

  test('ignores unknown fields rather than persisting them', async () => {
    const creds = credentials();
    const res = await request(app)
      .post('/auth/register')
      .send({ ...creds, id: 'attacker-chosen-id', role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe('attacker-chosen-id');
    expect(res.body.user.role).toBeUndefined();
  });
});

describe('POST /auth/login', () => {
  test('returns a token for correct credentials', async () => {
    const creds = credentials();
    await request(app).post('/auth/register').send(creds);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: creds.email, password: creds.password });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  test('rejects a wrong password with 401', async () => {
    const creds = credentials();
    await request(app).post('/auth/register').send(creds);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: creds.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  test('returns an identical response for unknown email and wrong password', async () => {
    const creds = credentials();
    await request(app).post('/auth/register').send(creds);

    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ email: creds.email, password: 'wrong-password' });
    const unknownEmail = await request(app)
      .post('/auth/login')
      .send({ email: uniqueEmail('ghost'), password: 'wrong-password' });

    // Differing status or message would let an attacker enumerate registered emails.
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
  });
});

describe('GET /users/me', () => {
  const registerAndLogin = async () => {
    const creds = credentials();
    const res = await request(app).post('/auth/register').send(creds);
    return { creds, token: res.body.token, user: res.body.user };
  };

  test('returns the authenticated user', async () => {
    const { token, user } = await registerAndLogin();

    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  test('rejects a request with no token', async () => {
    const res = await request(app).get('/users/me');
    expect(res.status).toBe(401);
  });

  test('rejects a malformed Authorization header', async () => {
    const { token } = await registerAndLogin();
    const res = await request(app).get('/users/me').set('Authorization', token);
    expect(res.status).toBe(401);
  });

  test('rejects a token signed with the wrong secret', async () => {
    const { user } = await registerAndLogin();
    const forged = jwt.sign({}, 'not-the-real-secret', { subject: user.id, issuer: 'fintrack' });

    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/invalid token/i);
  });

  test('rejects an expired token and says so', async () => {
    const { user } = await registerAndLogin();
    const expired = jwt.sign({}, process.env.JWT_SECRET, {
      subject: user.id,
      issuer: 'fintrack',
      expiresIn: '-1s',
    });

    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  test('identity comes from the token, not from the request body', async () => {
    const alice = await registerAndLogin();
    const bob = await registerAndLogin();

    // Bob's token, Alice's id in the body: the body must be ignored entirely.
    const res = await request(app)
      .get('/users/me')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ userId: alice.user.id });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(bob.user.id);
    expect(res.body.user.id).not.toBe(alice.user.id);
  });
});
