// Hand-written OpenAPI 3.0 description of the public API, served by Swagger UI at /docs.
// It is kept next to the code rather than generated: the zod schemas are the validation
// source of truth, and this file documents their contract for readers. Change a route's
// schema -> change it here too.

const uuid = { type: 'string', format: 'uuid' };
// Money travels as a decimal string so it never passes through a JS Number (invariant 1).
const money = { type: 'string', pattern: '^\\d+(\\.\\d{1,4})?$', example: '1500.0000' };
const cursor = { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'pageInfo.nextCursor from the previous page' };
const limit = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
const idParam = { name: 'id', in: 'path', required: true, schema: uuid };

const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorRef = (description) => ({ description, content: json(ref('Error')) });

const page = (item, key) => ({
  type: 'object',
  properties: {
    [key]: { type: 'array', items: ref(item) },
    pageInfo: ref('PageInfo'),
  },
});

const cacheHeader = { 'x-cache': { schema: { type: 'string', enum: ['HIT', 'MISS'] } } };
const pendingReport = {
  description: 'Not generated yet; retry after the Retry-After interval',
  content: json({
    type: 'object',
    properties: { status: { type: 'string', example: 'pending' }, message: { type: 'string' }, reportType: { type: 'string' }, periodStart: { type: 'string' } },
  }),
};

const secured = [{ bearerAuth: [] }];
const authErrors = { 401: errorRef('Missing, malformed or expired token') };

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'FinTrack API',
    version: '1.0.0',
    description: [
      'Transaction analytics backend: accounts, money movements (DEPOSIT / WITHDRAWAL / BUY / SELL), investment plans and subscriptions.',
      '',
      '**Try it:** `POST /auth/register`, copy the returned `token`, click **Authorize** and paste it. Every other endpoint is scoped to the authenticated user; identity comes only from the token.',
      '',
      'Monetary values are decimal **strings**, never floats.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Health' }, { name: 'Auth' }, { name: 'Users' }, { name: 'Accounts' },
    { name: 'Transactions' }, { name: 'Plans' }, { name: 'Subscriptions' },
    { name: 'Activity' }, { name: 'Analytics' }, { name: 'Reports' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness and dependency status',
        description: 'Returns 503 only when PostgreSQL is down; Redis and MongoDB degrade without failing the API.',
        responses: {
          200: { description: 'Healthy', content: json(ref('Health')) },
          503: { description: 'PostgreSQL unavailable', content: json(ref('Health')) },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create a user',
        requestBody: { required: true, content: json(ref('RegisterRequest')) },
        responses: {
          201: { description: 'Created', content: json(ref('AuthResult')) },
          409: errorRef('Email already registered'),
          422: errorRef('Validation failed'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange credentials for a JWT',
        requestBody: { required: true, content: json(ref('LoginRequest')) },
        responses: {
          200: { description: 'OK', content: json(ref('AuthResult')) },
          401: errorRef('Invalid email or password'),
          422: errorRef('Validation failed'),
        },
      },
    },
    '/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Current user',
        security: secured,
        responses: {
          200: { description: 'OK', content: json({ type: 'object', properties: { user: ref('User') } }) },
          ...authErrors,
        },
      },
    },
    '/accounts': {
      post: {
        tags: ['Accounts'],
        summary: 'Open an account',
        security: secured,
        requestBody: { required: true, content: json(ref('CreateAccountRequest')) },
        responses: {
          201: { description: 'Created', content: json({ type: 'object', properties: { account: ref('Account') } }) },
          ...authErrors,
          422: errorRef('Validation failed'),
        },
      },
      get: {
        tags: ['Accounts'],
        summary: 'List own accounts',
        security: secured,
        parameters: [limit, cursor],
        responses: { 200: { description: 'OK', content: json(page('Account', 'accounts')) }, ...authErrors },
      },
    },
    '/accounts/{id}': {
      get: {
        tags: ['Accounts'],
        summary: 'Get an own account',
        security: secured,
        parameters: [idParam],
        responses: {
          200: { description: 'OK', content: json({ type: 'object', properties: { account: ref('Account') } }) },
          ...authErrors,
          404: errorRef('Not found, or owned by someone else'),
        },
      },
    },
    '/transactions': {
      post: {
        tags: ['Transactions'],
        summary: 'Record a transaction',
        description: [
          'Atomically updates the account balance, writes the transaction and queues its event, under a row lock.',
          '',
          'Send an `Idempotency-Key` header to make retries safe: a repeat with the same key on the same account returns the original transaction with 200 and `replayed: true`.',
        ].join('\n'),
        security: secured,
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Client-chosen key, unique per account' }],
        requestBody: { required: true, content: json(ref('CreateTransactionRequest')) },
        responses: {
          201: { description: 'Created', content: json(ref('TransactionResult')) },
          200: { description: 'Idempotent replay of an earlier request', content: json(ref('TransactionResult')) },
          ...authErrors,
          404: errorRef('Account not found, or owned by someone else'),
          422: errorRef('Validation failed, insufficient funds, or insufficient holdings'),
        },
      },
      get: {
        tags: ['Transactions'],
        summary: 'List own transactions (newest first)',
        security: secured,
        parameters: [
          limit, cursor,
          { name: 'accountId', in: 'query', schema: uuid },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL'] } },
          { name: 'symbol', in: 'query', schema: { type: 'string' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: { description: 'OK', content: json(page('Transaction', 'transactions')) }, ...authErrors },
      },
    },
    '/transactions/{id}': {
      get: {
        tags: ['Transactions'],
        summary: 'Get an own transaction',
        security: secured,
        parameters: [idParam],
        responses: {
          200: { description: 'OK', content: json({ type: 'object', properties: { transaction: ref('Transaction') } }) },
          ...authErrors,
          404: errorRef('Not found, or owned by someone else'),
        },
      },
    },
    '/plans': {
      post: {
        tags: ['Plans'],
        summary: 'Create an investment plan',
        security: secured,
        requestBody: { required: true, content: json(ref('CreatePlanRequest')) },
        responses: {
          201: { description: 'Created', content: json({ type: 'object', properties: { plan: ref('Plan') } }) },
          ...authErrors,
          422: errorRef('Validation failed'),
        },
      },
      get: {
        tags: ['Plans'],
        summary: 'List own plans',
        security: secured,
        parameters: [limit, cursor, { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'CANCELLED'] } }],
        responses: { 200: { description: 'OK', content: json(page('Plan', 'plans')) }, ...authErrors },
      },
    },
    '/plans/{id}': {
      patch: {
        tags: ['Plans'],
        summary: 'Update a plan (partial)',
        security: secured,
        parameters: [idParam],
        requestBody: { required: true, content: json(ref('UpdatePlanRequest')) },
        responses: {
          200: { description: 'OK', content: json({ type: 'object', properties: { plan: ref('Plan') } }) },
          ...authErrors,
          404: errorRef('Not found, or owned by someone else'),
          422: errorRef('Validation failed (empty body is rejected)'),
        },
      },
    },
    '/subscriptions': {
      post: {
        tags: ['Subscriptions'],
        summary: 'Subscribe to a plan',
        security: secured,
        requestBody: { required: true, content: json({ type: 'object', required: ['planId'], properties: { planId: uuid } }) },
        responses: {
          201: { description: 'Created', content: json({ type: 'object', properties: { subscription: ref('Subscription') } }) },
          ...authErrors,
          404: errorRef('Plan not found, or owned by someone else'),
          409: errorRef('Already subscribed, or plan is cancelled'),
          422: errorRef('Validation failed'),
        },
      },
      get: {
        tags: ['Subscriptions'],
        summary: 'List own subscriptions',
        security: secured,
        parameters: [limit, cursor, { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'CANCELLED'] } }],
        responses: { 200: { description: 'OK', content: json(page('Subscription', 'subscriptions')) }, ...authErrors },
      },
    },
    '/subscriptions/{id}': {
      delete: {
        tags: ['Subscriptions'],
        summary: 'Cancel a subscription',
        security: secured,
        parameters: [idParam],
        responses: {
          200: { description: 'Cancelled', content: json({ type: 'object', properties: { subscription: ref('Subscription') } }) },
          ...authErrors,
          404: errorRef('Not found, or owned by someone else'),
        },
      },
    },
    '/activity': {
      get: {
        tags: ['Activity'],
        summary: 'Own activity event history (MongoDB)',
        description: 'Written asynchronously by the worker, so an event can appear a moment after the action.',
        security: secured,
        parameters: [
          limit, cursor,
          { name: 'eventType', in: 'query', schema: { type: 'string', enum: ['USER_REGISTERED', 'LOGIN', 'DEPOSIT_COMPLETED', 'WITHDRAWAL_COMPLETED', 'TRADE_EXECUTED', 'PLAN_CREATED', 'PLAN_UPDATED', 'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_CANCELLED'] } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: { description: 'OK', content: json(page('ActivityEvent', 'events')) }, ...authErrors },
      },
    },
    '/analytics/portfolio': {
      get: {
        tags: ['Analytics'],
        summary: 'Cash and open holdings',
        description: 'Cached in Redis; the `x-cache` response header reports HIT or MISS. Market value is null: there is no price feed.',
        security: secured,
        responses: { 200: { description: 'OK', headers: cacheHeader, content: json({ type: 'object' }) }, ...authErrors },
      },
    },
    '/analytics/pnl': {
      get: {
        tags: ['Analytics'],
        summary: 'Realised profit and loss (weighted-average method)',
        security: secured,
        responses: { 200: { description: 'OK', headers: cacheHeader, content: json({ type: 'object' }) }, ...authErrors },
      },
    },
    '/analytics/activity': {
      get: {
        tags: ['Analytics'],
        summary: 'Daily transaction volume and totals',
        description: 'Only the unfiltered view is cached.',
        security: secured,
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: { description: 'OK', headers: cacheHeader, content: json({ type: 'object' }) }, ...authErrors },
      },
    },
    '/reports/daily': {
      get: {
        tags: ['Reports'],
        summary: 'Daily report snapshot',
        description: 'Snapshots are generated by the worker. A missing one is requested and the call returns 202; retry shortly.',
        security: secured,
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string', example: '2026-10-25' }, description: 'YYYY-MM-DD; defaults to yesterday' }],
        responses: { 200: { description: 'Ready', headers: cacheHeader, content: json({ type: 'object', properties: { report: { type: 'object' } } }) }, 202: pendingReport, ...authErrors, 422: errorRef('Validation failed') },
      },
    },
    '/reports/monthly': {
      get: {
        tags: ['Reports'],
        summary: 'Monthly report snapshot',
        security: secured,
        parameters: [{ name: 'month', in: 'query', schema: { type: 'string', example: '2026-10' }, description: 'YYYY-MM; defaults to last month' }],
        responses: { 200: { description: 'Ready', headers: cacheHeader, content: json({ type: 'object', properties: { report: { type: 'object' } } }) }, 202: pendingReport, ...authErrors, 422: errorRef('Validation failed') },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
      PageInfo: {
        type: 'object',
        properties: {
          hasMore: { type: 'boolean' },
          nextCursor: { type: 'string', nullable: true },
          count: { type: 'integer' },
        },
      },
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          instance: { type: 'string' },
          uptimeSeconds: { type: 'integer' },
          checks: { type: 'object', additionalProperties: { type: 'object' } },
        },
      },
      RegisterRequest: {
        type: 'object',
        required: ['email', 'name', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'demo@example.com' },
          name: { type: 'string', maxLength: 120, example: 'Demo User' },
          password: { type: 'string', minLength: 8, maxLength: 72, example: 'correct-horse-battery' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
      },
      User: {
        type: 'object',
        properties: { id: uuid, email: { type: 'string' }, name: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } },
      },
      AuthResult: {
        type: 'object',
        properties: { user: ref('User'), token: { type: 'string', description: 'JWT; send as `Authorization: Bearer <token>`' } },
      },
      CreateAccountRequest: {
        type: 'object',
        required: ['accountType'],
        properties: {
          accountType: { type: 'string', enum: ['CHECKING', 'SAVINGS', 'BROKERAGE'] },
          currency: { type: 'string', minLength: 3, maxLength: 3, default: 'INR' },
        },
      },
      Account: {
        type: 'object',
        properties: {
          id: uuid,
          accountType: { type: 'string', enum: ['CHECKING', 'SAVINGS', 'BROKERAGE'] },
          balance: money,
          currency: { type: 'string', example: 'INR' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateTransactionRequest: {
        description: 'Cash movements (DEPOSIT/WITHDRAWAL) take `amount`; trades (BUY/SELL) take `symbol`, `quantity` and `price`. Unknown fields are rejected.',
        type: 'object',
        required: ['type', 'accountId'],
        properties: {
          type: { type: 'string', enum: ['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL'] },
          accountId: uuid,
          amount: { ...money, description: 'DEPOSIT / WITHDRAWAL only' },
          symbol: { type: 'string', maxLength: 20, example: 'INFY', description: 'BUY / SELL only' },
          quantity: { type: 'string', example: '10', description: 'BUY / SELL only; up to 8 decimals' },
          price: { ...money, description: 'BUY / SELL only' },
          occurredAt: { type: 'string', format: 'date-time' },
        },
        example: { type: 'DEPOSIT', accountId: '00000000-0000-0000-0000-000000000000', amount: '10000.00' },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: uuid,
          accountId: uuid,
          type: { type: 'string', enum: ['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL'] },
          symbol: { type: 'string', nullable: true },
          quantity: { type: 'string', nullable: true },
          price: { ...money, nullable: true },
          amount: money,
          status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
          transactionTime: { type: 'string', format: 'date-time' },
          idempotencyKey: { type: 'string' },
        },
      },
      TransactionResult: {
        type: 'object',
        properties: { transaction: ref('Transaction'), replayed: { type: 'boolean' } },
      },
      CreatePlanRequest: {
        type: 'object',
        required: ['name', 'planType', 'amount', 'frequency', 'startDate'],
        properties: {
          name: { type: 'string', maxLength: 120, example: 'Monthly index SIP' },
          planType: { type: 'string', enum: ['SIP', 'LUMPSUM', 'RECURRING'] },
          amount: money,
          frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'] },
          startDate: { type: 'string', format: 'date', example: '2026-11-01' },
        },
      },
      UpdatePlanRequest: {
        type: 'object',
        minProperties: 1,
        properties: {
          name: { type: 'string', maxLength: 120 },
          amount: money,
          frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'] },
          status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'CANCELLED'] },
        },
      },
      Plan: {
        type: 'object',
        properties: {
          id: uuid,
          name: { type: 'string' },
          planType: { type: 'string', enum: ['SIP', 'LUMPSUM', 'RECURRING'] },
          amount: money,
          frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'] },
          status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'CANCELLED'] },
          startDate: { type: 'string', format: 'date' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ActivityEvent: {
        type: 'object',
        properties: {
          eventId: uuid,
          eventType: { type: 'string' },
          entityType: { type: 'string' },
          entityId: { type: 'string' },
          metadata: { type: 'object' },
          occurredAt: { type: 'string', format: 'date-time' },
        },
      },
      Subscription: {
        type: 'object',
        properties: {
          id: uuid,
          planId: uuid,
          status: { type: 'string', enum: ['ACTIVE', 'CANCELLED'] },
          plan: { type: 'object', description: 'Included when the plan is joined in', nullable: true },
          startedAt: { type: 'string', format: 'date-time' },
          endedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
};
