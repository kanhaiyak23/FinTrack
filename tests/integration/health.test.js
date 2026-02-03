import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import { connectMongo, disconnectMongo } from '../../apps/api/src/db/mongo.js';
import { disconnectPostgres } from '../../apps/api/src/db/prisma.js';
import { disconnectRedis } from '../../apps/api/src/db/redis.js';

const app = createApp();

beforeAll(async () => {
  await connectMongo();
});

afterAll(async () => {
  await Promise.allSettled([disconnectPostgres(), disconnectMongo(), disconnectRedis()]);
});

describe('GET /health', () => {
  test('reports each subsystem independently', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Object.keys(res.body.checks).sort()).toEqual(['mongodb', 'postgres', 'redis']);

    for (const check of Object.values(res.body.checks)) {
      expect(check.status).toBe('up');
      expect(typeof check.latencyMs).toBe('number');
    }
  });

  test('attaches a request id and instance id to every response', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-instance-id']).toBeTruthy();
  });

  test('honours an upstream request id so logs correlate across Nginx', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'upstream-123');
    expect(res.headers['x-request-id']).toBe('upstream-123');
  });
});

describe('error handling', () => {
  test('unknown route returns a structured 404 carrying the request id', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/No route for GET/);
    expect(res.body.error.requestId).toBeTruthy();
  });
});
