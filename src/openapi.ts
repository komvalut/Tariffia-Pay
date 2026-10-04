/**
 * Hand-written OpenAPI 3.0 description of the existing public and merchant API.
 * It documents current endpoints only and contains no credentials, example keys or private data.
 */

import { MERCHANT_SCOPES } from './scopes.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './pagination.js';

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Machine-readable error code.' },
    message: { type: 'string', description: 'Human-readable, non-sensitive message.' },
  },
  required: ['error', 'message'],
};

const commonErrorResponses = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { $ref: '#/components/responses/NotFound' },
  409: { $ref: '#/components/responses/Conflict' },
  429: { $ref: '#/components/responses/RateLimited' },
};

const merchantSecurity = [{ merchantApiKey: [] }];
const adminSecurity = [{ adminApiKey: [] }];

// Shared pagination contract used by every merchant list endpoint.
const paginationParameters = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }, description: 'Page size (1 to 100). Defaults to 50; invalid values are rejected with 400 invalid_pagination.' },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Number of records to skip. Defaults to 0.' },
] as const;
const paginationProperty = { pagination: { $ref: '#/components/schemas/Pagination' } } as const;

const orderSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    customerId: { type: 'string', format: 'uuid', nullable: true },
    reference: { type: 'string', nullable: true },
    description: { type: 'string' },
    amount: { type: 'string', example: '12.500000' },
    currency: { type: 'string', example: 'USDC' },
    status: { type: 'string', enum: ['CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'] },
    statusLabel: { type: 'string', example: 'Pending' },
    paymentId: { type: 'string', format: 'uuid', nullable: true },
    paymentStatus: { type: 'string', nullable: true },
    paymentStatusLabel: { type: 'string', nullable: true },
    network: { type: 'string', nullable: true },
    transactionId: { type: 'string', nullable: true },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    detectedAt: { type: 'string', format: 'date-time', nullable: true },
    confirmedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const paymentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    amount: { type: 'string' },
    amountBaseUnits: { type: 'string' },
    currency: { type: 'string' },
    status: { type: 'string', enum: ['CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED'] },
    statusLabel: { type: 'string' },
    adapter: { type: 'string', example: 'usdc' },
    network: { type: 'string', example: 'base' },
    recipientAddress: { type: 'string' },
    tokenAddress: { type: 'string', nullable: true },
    transactionId: { type: 'string', nullable: true },
    transactionHash: { type: 'string', nullable: true },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    detectedAt: { type: 'string', format: 'date-time', nullable: true },
    confirmedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const transactionSchema = {
  type: 'object',
  properties: {
    paymentId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    description: { type: 'string' },
    amount: { type: 'string' },
    currency: { type: 'string' },
    status: { type: 'string' },
    statusLabel: { type: 'string' },
    network: { type: 'string' },
    adapter: { type: 'string' },
    transactionId: { type: 'string', nullable: true },
    transactionHash: { type: 'string', nullable: true },
    detectedAt: { type: 'string', format: 'date-time', nullable: true },
    confirmedAt: { type: 'string', format: 'date-time', nullable: true },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const customerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    externalId: { type: 'string', nullable: true },
    email: { type: 'string', nullable: true },
    name: { type: 'string', nullable: true },
    metadata: { type: 'object', additionalProperties: true },
    orderCount: { type: 'integer' },
    paymentCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const paymentLinkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    reference: { type: 'string', nullable: true },
    description: { type: 'string' },
    amount: { type: 'string' },
    currency: { type: 'string' },
    status: { type: 'string' },
    enabled: { type: 'boolean' },
    disabledAt: { type: 'string', format: 'date-time', nullable: true },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    checkoutUrl: { type: 'string', format: 'uri' },
    qrUrl: { type: 'string', format: 'uri' },
  },
};

const aiUsageSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    requestId: { type: 'string' },
    customerId: { type: 'string', format: 'uuid' },
    provider: { type: 'string' },
    model: { type: 'string' },
    pricingMode: { type: 'string', enum: ['PER_REQUEST', 'PER_1K_TOKENS', 'PER_REQUEST_AND_TOKENS'] },
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    customerPriceUsd: { type: 'string' },
    creditsDeducted: { type: 'string' },
    balanceAfter: { type: 'string' },
    currency: { type: 'string', example: 'CREDITS' },
    usageSource: { type: 'string', enum: ['provider', 'estimated', 'reported'], nullable: true },
  },
};

const auditEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    actorType: { type: 'string', enum: ['merchant', 'admin'] },
    actorId: { type: 'string', description: 'Identifier of the acting merchant or admin.' },
    action: { type: 'string', example: 'settings.update' },
    resourceType: { type: 'string', example: 'settings' },
    resourceId: { type: 'string', nullable: true },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Bounded, non-sensitive metadata (for example changed field names). Secrets, credentials, OTP codes and message content are never recorded.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const paginationSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer' },
    offset: { type: 'integer' },
    count: { type: 'integer' },
    hasMore: { type: 'boolean' },
  },
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Tariffia Pay API',
    version: '1.0.0',
    description: [
      'Public and merchant API for Tariffia Pay: non-custodial Base USDC payments, an internal',
      'credit engine, an AI reseller gateway, an SMS/OTP service and merchant self-service tools.',
      '',
      'Authentication: every merchant endpoint uses a merchant API key sent as',
      '`Authorization: Bearer <key>`. The admin-only operational health summary uses the',
      '`x-admin-api-key` header; public checkout, receipt and health probes need no authentication.',
      'Apart from that single admin health endpoint, admin routes are intentionally not documented.',
      'Merchant API keys carry scopes (`<area>:read` or `<area>:write`, where write implies read); a',
      'key missing the scope required by a route receives `403 insufficient_scope`. Keys issued before',
      'scope enforcement are grandfathered as full access. List endpoints use one pagination contract:',
      'optional `limit` (default 50, 1..100) and `offset` (default 0); invalid values return',
      '`400 invalid_pagination`, and every page includes a `pagination` object with',
      '`{ limit, offset, count, hasMore }`. Small configuration catalogues and per-parent histories are',
      'intentionally not paginated. This description covers existing public and',
      'merchant endpoints only; it never exposes or accepts secrets, private keys or provider credentials.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This Tariffia Pay instance' }],
  tags: [
    { name: 'Health', description: 'Liveness and readiness.' },
    { name: 'Orders', description: 'Create and read orders (existing Payment Core).' },
    { name: 'Payments', description: 'Payment status, verification and details.' },
    { name: 'Payment links', description: 'Hosted payment links and their management.' },
    { name: 'Transactions', description: 'Merchant-facing payment transaction views.' },
    { name: 'Customers', description: 'Customer records.' },
    { name: 'Revenue', description: 'Read-only revenue summaries and history.' },
    { name: 'Credits', description: 'Internal, non-withdrawable credit balances.' },
    { name: 'AI', description: 'AI reseller models, chat completions (streaming and non-streaming) and usage.' },
    { name: 'SMS', description: 'OTP/SMS services and delivery.' },
    { name: 'Webhooks', description: 'Merchant webhook endpoint and delivery management.' },
    { name: 'Subscriptions', description: 'Subscription plans, subscriptions and billing cycles.' },
    { name: 'Settings', description: 'Non-sensitive merchant settings.' },
    { name: 'Notifications', description: 'Merchant notification event preferences.' },
    { name: 'Usage', description: 'Per-merchant request usage and limits.' },
    { name: 'Audit log', description: 'Append-only record of important merchant actions.' },
    { name: 'API keys', description: 'Merchant self-service API keys.' },
    { name: 'Billing documents', description: 'Invoices and receipts for confirmed payments.' },
    { name: 'Ledger', description: 'Append-only merchant ledger entries.' },
    { name: 'Merchant dashboard', description: 'Read-only data views used by the merchant dashboard.' },
    { name: 'Admin', description: 'Operator-only endpoints authenticated with the x-admin-api-key header. Never use these from a browser or with a merchant key.' },
    { name: 'Public checkout', description: 'Public hosted checkout and QR.' },
    { name: 'Public receipts', description: 'Public receipt access for customers.' },
  ],
  security: [],
  paths: {
    '/health': {
      get: {
        tags: ['Health'], security: [], summary: 'Liveness probe',
        responses: {
          200: {
            description: 'API and database reachable.',
            content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, service: { type: 'string' } } } } },
          },
        },
      },
    },
    '/ready': {
      get: {
        tags: ['Health'], security: [], summary: 'Readiness probe',
        responses: { 200: { description: 'Ready.' }, 503: { description: 'Not ready.' } },
      },
    },
    '/v1/health': {
      get: {
        tags: ['Health'], security: [{ adminApiKey: [] }], summary: 'Operational health summary (admin only)',
        description: 'Admin-only operational summary. Reports only safe operational data; secrets, credentials, provider URLs and keys are never returned.',
        responses: {
          200: {
            description: 'Operational summary.',
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/orders': {
      post: {
        tags: ['Orders'], security: merchantSecurity, summary: 'Create an order and its payment',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 }, description: 'Stable key for retries.' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['description', 'amount'],
                properties: {
                  customerId: { type: 'string', format: 'uuid' },
                  reference: { type: 'string', maxLength: 128 },
                  description: { type: 'string', maxLength: 500 },
                  amount: { type: 'string', example: '4.50' },
                  currency: { type: 'string', default: 'USDC' },
                  adapter: { type: 'string' },
                  metadata: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Order and payment created.', content: { 'application/json': { schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' }, payment: { $ref: '#/components/schemas/Payment' }, checkoutUrl: { type: 'string', nullable: true }, qrUrl: { type: 'string', nullable: true } } } } } },
          ...commonErrorResponses,
        },
      },
      get: {
        tags: ['Orders'], security: merchantSecurity, summary: 'List your orders',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'] } },
          ...paginationParameters,
        ],
        responses: {
          200: { description: 'Orders, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { orders: { type: 'array', items: { $ref: '#/components/schemas/Order' } }, ...paginationProperty } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/orders/{orderId}': {
      get: {
        tags: ['Orders'], security: merchantSecurity, summary: 'Get one order',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'The order with its linked payment status and timestamps.', content: { 'application/json': { schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/payments/{paymentId}': {
      get: {
        tags: ['Payments'], security: merchantSecurity, summary: 'Get one payment',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'The payment.', content: { 'application/json': { schema: { type: 'object', properties: { payment: { $ref: '#/components/schemas/Payment' } } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/payments/{paymentId}/details': {
      get: {
        tags: ['Payments'], security: merchantSecurity, summary: 'Payment details with order, invoice and receipt',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Payment, order information and, when confirmed, the issued invoice and receipt.',
            content: { 'application/json': { schema: { type: 'object', properties: { payment: { $ref: '#/components/schemas/Payment' }, order: { $ref: '#/components/schemas/Order' }, invoice: { type: 'object', nullable: true, additionalProperties: true }, receipt: { type: 'object', nullable: true, additionalProperties: true } } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/payments/{paymentId}/verify': {
      post: {
        tags: ['Payments'], security: merchantSecurity, summary: 'Submit a transaction id/hash hint for verification',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { transactionHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }, transactionId: { type: 'string', maxLength: 512 } }, description: 'Provide exactly one of transactionHash or transactionId.' } } },
        },
        responses: {
          200: { description: 'Verified and recorded (paid).' },
          202: { description: 'Accepted for verification; still pending.' },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/payment-links': {
      post: {
        tags: ['Payment links'], security: merchantSecurity, summary: 'Create a hosted payment link',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: 'Same body as POST /v1/orders.' } } } },
        responses: {
          201: { description: 'Link created.', content: { 'application/json': { schema: { type: 'object', properties: { checkoutUrl: { type: 'string', format: 'uri' }, qrUrl: { type: 'string', format: 'uri' } } } } } },
          ...commonErrorResponses,
        },
      },
      get: {
        tags: ['Payment links'], security: merchantSecurity, summary: 'List your payment links',
        parameters: [...paginationParameters],
        responses: {
          200: { description: 'Payment links, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { paymentLinks: { type: 'array', items: { $ref: '#/components/schemas/PaymentLink' } }, ...paginationProperty } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/payment-links/{paymentId}': {
      get: {
        tags: ['Payment links'], security: merchantSecurity, summary: 'Get one payment link',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'The link.', content: { 'application/json': { schema: { type: 'object', properties: { paymentLink: { $ref: '#/components/schemas/PaymentLink' } } } } } }, ...commonErrorResponses },
      },
      patch: {
        tags: ['Payment links'], security: merchantSecurity, summary: 'Enable or disable a payment link',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } }, additionalProperties: false } } } },
        responses: { 200: { description: 'Updated link.', content: { 'application/json': { schema: { type: 'object', properties: { paymentLink: { $ref: '#/components/schemas/PaymentLink' } } } } } }, ...commonErrorResponses },
      },
      delete: {
        tags: ['Payment links'], security: merchantSecurity, summary: 'Delete (soft-deactivate) a payment link',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 204: { description: 'Deleted.' }, ...commonErrorResponses },
      },
    },
    '/v1/transactions': {
      get: {
        tags: ['Transactions'], security: merchantSecurity, summary: 'List your payment transactions',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED'] } },
          { name: 'network', in: 'query', schema: { type: 'string' } },
          ...paginationParameters,
        ],
        responses: { 200: { description: 'Transactions, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { transactions: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/transactions/{paymentId}': {
      get: {
        tags: ['Transactions'], security: merchantSecurity, summary: 'Get one transaction',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'The transaction.', content: { 'application/json': { schema: { type: 'object', properties: { transaction: { $ref: '#/components/schemas/Transaction' } } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/customers': {
      post: {
        tags: ['Customers'], security: merchantSecurity, summary: 'Create or update a customer',
        description: [
          'Idempotent, merchant-scoped create/update. Identity resolution order: an explicit',
          '`externalId` match wins; otherwise the request matches an existing customer by normalized',
          '`email` (trimmed and lowercased). A repeat of the same request returns the existing customer',
          'instead of creating a duplicate, and a same-email email-only customer is promoted in place',
          'when an `externalId` is later supplied. A different `externalId` with the same email stays a',
          'distinct customer. Only provided fields change and `metadata` is shallow-merged.',
        ].join(' '),
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { externalId: { type: 'string', maxLength: 128 }, email: { type: 'string', format: 'email', description: 'Trimmed and matched case-insensitively.' }, name: { type: 'string', maxLength: 120 }, metadata: { type: 'object', additionalProperties: true } }, description: 'externalId or email is required.' } } },
        },
        responses: { 201: { description: 'Customer created or updated.', content: { 'application/json': { schema: { type: 'object', properties: { customer: { $ref: '#/components/schemas/Customer' } } } } } }, ...commonErrorResponses },
      },
      get: {
        tags: ['Customers'], security: merchantSecurity, summary: 'List your customers',
        parameters: [...paginationParameters],
        responses: { 200: { description: 'Customers, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { customers: { type: 'array', items: { $ref: '#/components/schemas/Customer' } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/customers/{customerId}': {
      get: {
        tags: ['Customers'], security: merchantSecurity, summary: 'Get one customer',
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'The customer with order/payment counts.', content: { 'application/json': { schema: { type: 'object', properties: { customer: { $ref: '#/components/schemas/Customer' } } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/revenue/summary': {
      get: {
        tags: ['Revenue'], security: merchantSecurity, summary: 'Read-only revenue summary',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          200: {
            description: 'Confirmed revenue and payment status counts.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    revenue: {
                      type: 'object',
                      properties: {
                        currency: { type: 'string', nullable: true },
                        totalConfirmed: { type: 'string', nullable: true },
                        confirmedPaymentCount: { type: 'integer' },
                        pendingPaymentCount: { type: 'integer' },
                        failedPaymentCount: { type: 'integer' },
                        expiredPaymentCount: { type: 'integer' },
                        totalsByCurrency: { type: 'object', additionalProperties: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/revenue/history': {
      get: {
        tags: ['Revenue'], security: merchantSecurity, summary: 'Daily confirmed revenue history',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'currency', in: 'query', schema: { type: 'string', example: 'USDC' } },
        ],
        responses: {
          200: {
            description: 'One entry per UTC day (and currency when more than one is settled).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    history: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          date: { type: 'string', example: '2026-01-02' },
                          currency: { type: 'string' },
                          confirmedAmount: { type: 'string' },
                          confirmedPaymentCount: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/credits/topups': {
      post: {
        tags: ['Credits'], security: merchantSecurity, summary: 'Create a USDC payment request that tops up a customer credit balance',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['customerId', 'amount'], properties: { customerId: { type: 'string', format: 'uuid' }, amount: { type: 'string' } } } } } },
        responses: { 201: { description: 'Top-up payment request created.' }, ...commonErrorResponses },
      },
    },
    '/v1/credits/deductions': {
      post: {
        tags: ['Credits'], security: merchantSecurity, summary: 'Deduct credits from a customer account',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['customerId', 'amount'], properties: { customerId: { type: 'string', format: 'uuid' }, amount: { type: 'string' }, reference: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } } } } } },
        responses: { 201: { description: 'Deduction recorded.' }, ...commonErrorResponses },
      },
    },
    '/v1/credits/{customerId}/balance': {
      get: {
        tags: ['Credits'], security: merchantSecurity, summary: 'Get a customer credit balance',
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Balance in credits.' }, ...commonErrorResponses },
      },
    },
    '/v1/credits/{customerId}/topups': {
      get: {
        tags: ['Credits'], security: merchantSecurity, summary: 'List a customer credit top-ups',
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ...paginationParameters],
        responses: { 200: { description: 'Top-ups, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { accountId: { type: 'string' }, topups: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/credits/{customerId}/usage': {
      get: {
        tags: ['Credits'], security: merchantSecurity, summary: 'List a customer credit usage',
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ...paginationParameters],
        responses: { 200: { description: 'Usage records, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { accountId: { type: 'string' }, usage: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/ai/models': {
      get: {
        tags: ['AI'], security: merchantSecurity, summary: 'List enabled AI models with customer prices',
        description: 'Not paginated: the enabled model catalogue is small and configuration-driven.',
        responses: {
          200: {
            description: 'Enabled models. Provider costs and margins are not exposed.',
            content: { 'application/json': { schema: { type: 'object', properties: { models: { type: 'array', items: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, pricingMode: { type: 'string' }, pricePerRequestUsd: { type: 'string' }, inputPricePer1kUsd: { type: 'string' }, outputPricePer1kUsd: { type: 'string' }, maxOutputTokens: { type: 'integer' }, providerConfigured: { type: 'boolean' } } } } } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/ai/chat/completions': {
      post: {
        tags: ['AI'], security: merchantSecurity, summary: 'Create a chat completion through the configured AI provider',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId', 'customerId', 'provider', 'model', 'messages'],
                properties: {
                  requestId: { type: 'string', description: 'Stable idempotency identifier.' },
                  customerId: { type: 'string', format: 'uuid' },
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  messages: { type: 'array', items: { type: 'object', required: ['role', 'content'], properties: { role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] }, content: { type: 'string' }, toolCallId: { type: 'string' }, toolCalls: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
                  maxOutputTokens: { type: 'integer', minimum: 1, maximum: 4096 },
                  temperature: { type: 'number', minimum: 0, maximum: 2 },
                  tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  toolChoice: { type: 'string', enum: ['auto', 'none', 'required'] },
                  metadata: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Completion with normalized tool calls and the settled charge.', content: { 'application/json': { schema: { type: 'object', properties: { request: { type: 'object', additionalProperties: true }, usage: { $ref: '#/components/schemas/AiUsage' } } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/ai/chat/stream': {
      post: {
        tags: ['AI'], security: merchantSecurity, summary: 'Stream a chat completion over server-sent events',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: 'Same body as POST /v1/ai/chat/completions.' } } } },
        responses: {
          200: { description: 'text/event-stream of chunk/tool_call/finish/done/error events.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/ai/usage': {
      get: {
        tags: ['AI'], security: merchantSecurity, summary: 'List recorded AI usage for this merchant',
        parameters: [{ name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } }, ...paginationParameters],
        responses: { 200: { description: 'Usage records without provider costs or margins.', content: { 'application/json': { schema: { type: 'object', properties: { usage: { type: 'array', items: { $ref: '#/components/schemas/AiUsage' } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
      post: {
        tags: ['AI'], security: merchantSecurity, summary: 'Report completed AI usage (trusted server-to-server)', description: 'Merchant-reported token counts; not verified against a provider.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['requestId', 'customerId', 'provider', 'model'], properties: { requestId: { type: 'string' }, customerId: { type: 'string', format: 'uuid' }, provider: { type: 'string' }, model: { type: 'string' }, inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true } } } } } },
        responses: { 201: { description: 'Usage recorded and charged.', content: { 'application/json': { schema: { type: 'object', properties: { usage: { $ref: '#/components/schemas/AiUsage' } } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/sms/services': {
      get: {
        tags: ['SMS'], security: merchantSecurity, summary: 'List enabled SMS/OTP services and customer prices',
        description: 'Not paginated: the enabled SMS service catalogue is small and configuration-driven.',
        responses: { 200: { description: 'Enabled services.' }, ...commonErrorResponses },
      },
    },
    '/v1/sms/send': {
      post: {
        tags: ['SMS'], security: merchantSecurity, summary: 'Send an SMS and charge credits',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['requestId', 'service', 'to', 'message'], properties: { requestId: { type: 'string' }, service: { type: 'string' }, to: { type: 'string', example: '+381601234567' }, message: { type: 'string', maxLength: 1600 }, customerId: { type: 'string', format: 'uuid' }, metadata: { type: 'object', additionalProperties: true } } } } },
        },
        responses: {
          201: { description: 'SMS accepted and charged.', content: { 'application/json': { schema: { type: 'object', properties: { request: { type: 'object', additionalProperties: true }, usage: { type: 'object', additionalProperties: true } } } } } },
          ...commonErrorResponses,
          503: { $ref: '#/components/responses/ServiceUnavailable' },
          504: { $ref: '#/components/responses/GatewayTimeout' },
        },
      },
    },
    '/v1/sms/otp': {
      post: {
        tags: ['SMS'], security: merchantSecurity, summary: 'Generate and send an OTP over SMS',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['requestId', 'service', 'to'], properties: { requestId: { type: 'string' }, service: { type: 'string' }, to: { type: 'string', example: '+381601234567' }, customerId: { type: 'string', format: 'uuid' }, metadata: { type: 'object', additionalProperties: true } } } } },
        },
        responses: {
          201: { description: 'OTP sent and charged. The code is never returned or stored.' },
          ...commonErrorResponses,
          503: { $ref: '#/components/responses/ServiceUnavailable' },
          504: { $ref: '#/components/responses/GatewayTimeout' },
        },
      },
    },
    '/v1/webhooks': {
      get: { tags: ['Webhooks'], security: merchantSecurity, summary: 'List your webhook endpoints', parameters: [...paginationParameters], responses: { 200: { description: 'Endpoints, newest first. Signing secrets are never returned.', content: { 'application/json': { schema: { type: 'object', properties: { endpoints: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
      post: {
        tags: ['Webhooks'], security: merchantSecurity, summary: 'Create a webhook endpoint',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'url', 'events', 'secret'], properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, secret: { type: 'string', minLength: 32, maxLength: 256, description: 'Signing secret; stored encrypted and never returned.' } } } } } },
        responses: { 201: { description: 'Endpoint created (without the secret).' }, ...commonErrorResponses },
      },
    },
    '/v1/webhooks/{endpointId}': {
      patch: {
        tags: ['Webhooks'], security: merchantSecurity, summary: 'Update a webhook endpoint (url, events, name, secret, enabled)',
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, secret: { type: 'string' }, enabled: { type: 'boolean' } } } } } },
        responses: { 200: { description: 'Updated endpoint.' }, ...commonErrorResponses },
      },
      delete: {
        tags: ['Webhooks'], security: merchantSecurity, summary: 'Delete a webhook endpoint',
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 204: { description: 'Deleted.' }, ...commonErrorResponses },
      },
    },
    '/v1/webhooks/{endpointId}/deliveries': {
      get: {
        tags: ['Webhooks'], security: merchantSecurity, summary: 'List deliveries for an endpoint',
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, ...paginationParameters],
        responses: { 200: { description: 'Delivery history, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { deliveries: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/webhooks/{endpointId}/deliveries/{deliveryId}/attempts': {
      get: {
        tags: ['Webhooks'], security: merchantSecurity, summary: 'List delivery attempts',
        description: 'Not paginated: attempts for a single delivery are bounded by the configured max attempts.',
        parameters: [
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'deliveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { 200: { description: 'Attempts with normalized errors.' }, ...commonErrorResponses },
      },
    },
    '/v1/subscription-plans': {
      get: { tags: ['Subscriptions'], security: merchantSecurity, summary: 'List subscription plans', description: 'Not paginated: plan catalogues are a small configuration set.', responses: { 200: { description: 'Plans.' }, ...commonErrorResponses } },
      post: {
        tags: ['Subscriptions'], security: merchantSecurity, summary: 'Create a subscription plan',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'amount', 'interval'], properties: { name: { type: 'string' }, description: { type: 'string' }, amount: { type: 'string' }, currency: { type: 'string', default: 'USDC' }, interval: { type: 'string', enum: ['DAY', 'WEEK', 'MONTH', 'YEAR'] }, intervalCount: { type: 'integer', minimum: 1, maximum: 12 }, trialDays: { type: 'integer', minimum: 0, maximum: 365 }, enabled: { type: 'boolean' } } } } } },
        responses: { 201: { description: 'Plan created.' }, ...commonErrorResponses },
      },
    },
    '/v1/subscription-plans/{planId}': {
      put: {
        tags: ['Subscriptions'], security: merchantSecurity, summary: 'Update a subscription plan',
        parameters: [{ name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Updated plan.' }, ...commonErrorResponses },
      },
    },
    '/v1/subscriptions': {
      get: { tags: ['Subscriptions'], security: merchantSecurity, summary: 'List subscriptions', description: 'Not paginated: subscriptions are bounded per merchant and used as a small working set.', responses: { 200: { description: 'Subscriptions.' }, ...commonErrorResponses } },
      post: {
        tags: ['Subscriptions'], security: merchantSecurity, summary: 'Create a subscription',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['planId', 'customerId'], properties: { planId: { type: 'string', format: 'uuid' }, customerId: { type: 'string', format: 'uuid' }, adapter: { type: 'string' }, billingMode: { type: 'string', enum: ['MANUAL', 'AUTOMATIC'], default: 'MANUAL' }, endsAt: { type: 'string', format: 'date-time' } } } } } },
        responses: { 201: { description: 'Subscription created.' }, ...commonErrorResponses, 422: { $ref: '#/components/responses/Unprocessable' } },
      },
    },
    '/v1/subscriptions/{subscriptionId}': {
      get: { tags: ['Subscriptions'], security: merchantSecurity, summary: 'Get one subscription', parameters: [{ name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Subscription.' }, ...commonErrorResponses } },
      patch: {
        tags: ['Subscriptions'], security: merchantSecurity, summary: 'Pause, resume or cancel a subscription',
        parameters: [{ name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { type: 'string', enum: ['pause', 'resume', 'cancel'] } } } } } },
        responses: { 200: { description: 'Updated subscription.' }, ...commonErrorResponses },
      },
    },
    '/v1/subscriptions/{subscriptionId}/renew': {
      post: {
        tags: ['Subscriptions'], security: merchantSecurity, summary: 'Manually renew a subscription',
        parameters: [{ name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        responses: { 201: { description: 'Renewal billing attempt created.' }, ...commonErrorResponses },
      },
    },
    '/v1/subscriptions/{subscriptionId}/billing-cycles': {
      get: { tags: ['Subscriptions'], security: merchantSecurity, summary: 'List billing cycles', description: 'Not paginated: cycles for a single subscription are a bounded per-parent history.', parameters: [{ name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Billing cycles with attempts.' }, ...commonErrorResponses } },
    },
    '/v1/customers/{customerId}/subscriptions': {
      get: { tags: ['Subscriptions'], security: merchantSecurity, summary: 'List a customer subscriptions', description: 'Not paginated: subscriptions for one customer are a bounded per-parent set.', parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Subscriptions.' }, ...commonErrorResponses } },
    },
    '/v1/settings': {
      get: { tags: ['Settings'], security: merchantSecurity, summary: 'Read non-sensitive merchant settings', responses: { 200: { description: 'Settings.' }, ...commonErrorResponses } },
      put: {
        tags: ['Settings'], security: merchantSecurity, summary: 'Update non-sensitive merchant settings',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { displayName: { type: 'string', nullable: true, maxLength: 120 }, supportEmail: { type: 'string', format: 'email', nullable: true }, defaultCurrency: { type: 'string', nullable: true, example: 'USDC' }, timezone: { type: 'string', nullable: true, example: 'UTC' } }, description: 'Unknown fields (including API keys, secrets, wallet addresses and status) are rejected.' } } },
        },
        responses: { 200: { description: 'Updated settings.' }, ...commonErrorResponses },
      },
    },
    '/v1/notification-preferences': {
      get: { tags: ['Notifications'], security: merchantSecurity, summary: 'Read notification preferences (all enabled by default)', responses: { 200: { description: 'Preferences.' }, ...commonErrorResponses } },
      put: {
        tags: ['Notifications'], security: merchantSecurity, summary: 'Update notification preferences',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['paymentConfirmed', 'paymentFailed', 'paymentExpired', 'creditTopup', 'aiRequestFailed', 'smsRequestFailed', 'webhookFailed'],
                properties: {
                  paymentConfirmed: { type: 'boolean' }, paymentFailed: { type: 'boolean' }, paymentExpired: { type: 'boolean' },
                  creditTopup: { type: 'boolean' }, aiRequestFailed: { type: 'boolean' }, smsRequestFailed: { type: 'boolean' },
                  webhookFailed: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated preferences.' }, ...commonErrorResponses },
      },
    },
    '/v1/usage': {
      get: {
        tags: ['Usage'], security: merchantSecurity, summary: 'Read your request usage and limits',
        responses: {
          200: {
            description: 'Per-category usage for the current window.',
            content: { 'application/json': { schema: { type: 'object', properties: { usage: { type: 'object', properties: { general: { $ref: '#/components/schemas/UsageCategory' }, ai: { $ref: '#/components/schemas/UsageCategory' }, sms: { $ref: '#/components/schemas/UsageCategory' } } } } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/api-keys': {
      get: { tags: ['API keys'], security: merchantSecurity, summary: 'List your API keys (no secrets or hashes)', description: 'Not paginated: API keys are a small, bounded set per merchant.', responses: { 200: { description: 'API key metadata with status and last-used time.' }, ...commonErrorResponses } },
      post: {
        tags: ['API keys'], security: merchantSecurity, summary: 'Create an API key (secret returned once)',
        description: 'Creates a scoped API key. When `scopes` is omitted the key receives the full default scope catalogue. The plaintext secret is returned only once.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', maxLength: 80 },
                  scopes: {
                    type: 'array',
                    minItems: 1,
                    uniqueItems: true,
                    items: { type: 'string', enum: [...MERCHANT_SCOPES] },
                    description: 'Optional narrower scope set. Omit for the full default catalogue.',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Key created. The plaintext secret is returned only in this response and only its hash is stored.',
            content: { 'application/json': { schema: { type: 'object', properties: { apiKey: { type: 'object', additionalProperties: true }, secret: { type: 'string', description: 'Shown once; store securely.' }, warning: { type: 'string' } } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/api-keys/{keyId}': {
      delete: {
        tags: ['API keys'], security: merchantSecurity, summary: 'Revoke an API key (immediate)',
        parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 204: { description: 'Revoked.' }, ...commonErrorResponses },
      },
    },
    '/v1/audit-log': {
      get: {
        tags: ['Audit log'], security: merchantSecurity, summary: 'List your append-only audit log (newest first)',
        description: 'Merchant-scoped, append-only history of important account actions. Only safe metadata is stored; API keys, secrets, OTP codes and message content are never recorded.',
        parameters: [...paginationParameters],
        responses: {
          200: {
            description: 'Audit entries for the authenticated merchant, newest first.',
            content: { 'application/json': { schema: { type: 'object', properties: { entries: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } }, ...paginationProperty } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/dashboard/overview': {
      get: {
        tags: ['Merchant dashboard'], security: merchantSecurity, summary: 'Merchant dashboard overview counters',
        responses: {
          200: {
            description: 'Aggregated counters for the authenticated merchant.',
            content: { 'application/json': { schema: { type: 'object', properties: { overview: { type: 'object', additionalProperties: true } } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/dashboard/{collection}': {
      get: {
        tags: ['Merchant dashboard'], security: merchantSecurity, summary: 'Read a merchant dashboard collection',
        parameters: [
          { name: 'collection', in: 'path', required: true, schema: { type: 'string', enum: ['customers', 'orders', 'payments', 'payment-links', 'credit-accounts', 'credit-transactions', 'topups', 'usage', 'webhook-endpoints', 'webhook-deliveries'] } },
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 120 } },
          { name: 'status', in: 'query', schema: { type: 'string', maxLength: 32 } },
          ...paginationParameters,
        ],
        responses: {
          200: {
            description: 'Paginated collection rows for the authenticated merchant.',
            content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } },
          },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/invoices': {
      get: { tags: ['Billing documents'], security: merchantSecurity, summary: 'List invoices for confirmed payments', parameters: [...paginationParameters], responses: { 200: { description: 'Invoices, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { invoices: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/invoices/{invoiceRef}': {
      get: { tags: ['Billing documents'], security: merchantSecurity, summary: 'Get one invoice by id or number', parameters: [{ name: 'invoiceRef', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Invoice.' }, ...commonErrorResponses } },
    },
    '/v1/invoices/{invoiceRef}.pdf': {
      get: { tags: ['Billing documents'], security: merchantSecurity, summary: 'Download an invoice PDF', parameters: [{ name: 'invoiceRef', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'PDF document.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...commonErrorResponses } },
    },
    '/v1/receipts': {
      get: { tags: ['Billing documents'], security: merchantSecurity, summary: 'List receipts for confirmed payments', parameters: [...paginationParameters], responses: { 200: { description: 'Receipts, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { receipts: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/receipts/{receiptId}': {
      get: { tags: ['Billing documents'], security: merchantSecurity, summary: 'Get one receipt', parameters: [{ name: 'receiptId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Receipt.' }, ...commonErrorResponses } },
    },
    '/v1/receipts/{receiptId}.pdf': {
      get: { tags: ['Billing documents'], security: merchantSecurity, summary: 'Download a receipt PDF', parameters: [{ name: 'receiptId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'PDF document.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...commonErrorResponses } },
    },
    '/v1/ledger': {
      get: { tags: ['Ledger'], security: merchantSecurity, summary: 'List your append-only ledger entries', parameters: [...paginationParameters], responses: { 200: { description: 'Ledger entries, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/public/payment-methods': {
      get: { tags: ['Public checkout'], security: [], summary: 'List payment methods available for checkout', responses: { 200: { description: 'Enabled, healthy methods.' } } },
    },
    '/v1/public/payments/{paymentId}': {
      get: {
        tags: ['Public checkout'], security: [], summary: 'Public payment view for the hosted checkout',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Limited public payment view.' }, 404: { $ref: '#/components/responses/NotFound' } },
      },
    },
    '/v1/public/payments/{paymentId}/verify': {
      post: {
        tags: ['Public checkout'], security: [], summary: 'Public verification hint for a hosted checkout',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { transactionHash: { type: 'string' }, transactionId: { type: 'string' } } } } } },
        responses: { 200: { description: 'Verified.' }, 202: { description: 'Pending.' }, 404: { $ref: '#/components/responses/NotFound' } },
      },
    },
    '/p/{paymentId}': {
      get: { tags: ['Public checkout'], security: [], summary: 'Hosted checkout page', parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'HTML checkout page.', content: { 'text/html': { schema: { type: 'string' } } } } } },
    },
    '/p/{paymentId}/qr.png': {
      get: { tags: ['Public checkout'], security: [], summary: 'Checkout QR image', parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'PNG QR image.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } } } },
    },
    '/v1/public/receipts/{publicId}': {
      get: { tags: ['Public receipts'], security: [], summary: 'Public receipt by opaque id', parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string', minLength: 43, maxLength: 43 } }], responses: { 200: { description: 'Limited public receipt.' }, 404: { $ref: '#/components/responses/NotFound' } } },
    },
    '/v1/public/receipts/{publicId}.pdf': {
      get: { tags: ['Public receipts'], security: [], summary: 'Public receipt PDF', parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string', minLength: 43, maxLength: 43 } }], responses: { 200: { description: 'PDF document.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 404: { $ref: '#/components/responses/NotFound' } } },
    },
    '/r/{publicId}': {
      get: { tags: ['Public receipts'], security: [], summary: 'Public receipt page', parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string', minLength: 43, maxLength: 43 } }], responses: { 200: { description: 'HTML receipt page.', content: { 'text/html': { schema: { type: 'string' } } } } } },
    },

    // --- Admin API (operator-only; x-admin-api-key) -------------------------
    // Documented to complete the machine-readable contract. These endpoints are
    // never used by the merchant SDK and must never be called from a browser.
    '/v1/admin/merchants': {
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Provision a merchant and issue its first API key',
        description: 'Creates a merchant and returns a one-time merchant API key. Store the key securely; only its hash is retained.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'walletAddress'],
                properties: {
                  name: { type: 'string', maxLength: 120 },
                  email: { type: 'string', format: 'email', maxLength: 254 },
                  walletAddress: { type: 'string', description: 'EVM recipient address for USDC on Base.' },
                  apiKeyName: { type: 'string', maxLength: 80, default: 'Primary' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Merchant provisioned; the plaintext API key is returned once.', content: { 'application/json': { schema: { type: 'object', properties: { merchant: { type: 'object', additionalProperties: true }, apiKey: { type: 'string', description: 'Shown once; store securely.' }, warning: { type: 'string' } } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/admin/dashboard/overview': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'Platform-wide dashboard counters', responses: { 200: { description: 'Aggregated platform counters.', content: { 'application/json': { schema: { type: 'object', properties: { overview: { type: 'object', additionalProperties: true } } } } } }, ...commonErrorResponses } },
    },
    '/v1/admin/dashboard/{collection}': {
      get: {
        tags: ['Admin'], security: adminSecurity, summary: 'Read a platform-wide dashboard collection',
        parameters: [
          { name: 'collection', in: 'path', required: true, schema: { type: 'string', enum: ['merchants', 'customers', 'orders', 'payments', 'usdc-transactions', 'failed-payments', 'credit-accounts', 'credit-transactions', 'ai-providers', 'ai-models', 'usage', 'webhook-endpoints', 'webhook-deliveries'] } },
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 120 } },
          { name: 'status', in: 'query', schema: { type: 'string', maxLength: 32 } },
          ...paginationParameters,
        ],
        responses: {
          200: { description: 'Paginated collection rows across merchants.', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/admin/credits/settings': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'Read credit engine settings', responses: { 200: { description: 'Credit settings.' }, ...commonErrorResponses } },
      put: {
        tags: ['Admin'], security: adminSecurity, summary: 'Update credit engine settings',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Updated credit settings.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/credits/accounts': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List credit accounts across merchants', parameters: [...paginationParameters], responses: { 200: { description: 'Credit accounts, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { accounts: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/admin/credits/transactions': {
      get: {
        tags: ['Admin'], security: adminSecurity, summary: 'List credit transactions across merchants',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['TOPUP', 'DEDUCTION'] } },
          ...paginationParameters,
        ],
        responses: { 200: { description: 'Credit transactions, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { transactions: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/providers': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List AI providers (status only, no credentials)', responses: { 200: { description: 'AI provider summaries.' }, ...commonErrorResponses } },
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Register an AI provider',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: 'Provider label and non-secret configuration. Credentials are read from server environment only.' } } } },
        responses: { 201: { description: 'Provider registered.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/providers/{providerId}': {
      put: {
        tags: ['Admin'], security: adminSecurity, summary: 'Update an AI provider (label/enabled state)',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Updated provider.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/providers/{providerId}/models': {
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Add a model and pricing to an AI provider',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 201: { description: 'Model added.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/providers/{providerId}/models/discovery': {
      get: {
        tags: ['Admin'], security: adminSecurity, summary: 'Discover models offered by an AI provider',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Discovered model list (no credentials).' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/providers/{providerId}/health': {
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Check an AI provider health',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Bounded health status (no secrets).' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/models': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List AI models and pricing', responses: { 200: { description: 'Models with provider costs, customer prices and markup.' }, ...commonErrorResponses } },
    },
    '/v1/admin/ai/models/{modelId}': {
      put: {
        tags: ['Admin'], security: adminSecurity, summary: 'Update a model and its pricing',
        parameters: [{ name: 'modelId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Updated model.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/ai/usage': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List AI usage across merchants', parameters: [{ name: 'merchantId', in: 'query', schema: { type: 'string', format: 'uuid' } }, ...paginationParameters], responses: { 200: { description: 'AI usage records.', content: { 'application/json': { schema: { type: 'object', properties: { usage: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/admin/ai/requests': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List AI provider requests', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, ...paginationParameters], responses: { 200: { description: 'Provider request records.' }, ...commonErrorResponses } },
    },
    '/v1/admin/sms/providers': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List SMS providers (status only, no credentials)', responses: { 200: { description: 'SMS provider summaries.' }, ...commonErrorResponses } },
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Register an SMS provider',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: 'Provider label and non-secret configuration. Credentials are read from server environment only.' } } } },
        responses: { 201: { description: 'Provider registered.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/sms/providers/{providerId}': {
      put: {
        tags: ['Admin'], security: adminSecurity, summary: 'Update an SMS provider (label/enabled state)',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Updated provider.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/sms/providers/{providerId}/services': {
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Add a service to an SMS provider',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 201: { description: 'Service added.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/sms/providers/{providerId}/health': {
      post: {
        tags: ['Admin'], security: adminSecurity, summary: 'Check an SMS provider health',
        parameters: [{ name: 'providerId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Bounded health status (no secrets).' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/sms/services': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List SMS services', responses: { 200: { description: 'SMS services.' }, ...commonErrorResponses } },
    },
    '/v1/admin/sms/services/{serviceId}': {
      put: {
        tags: ['Admin'], security: adminSecurity, summary: 'Update an SMS service',
        parameters: [{ name: 'serviceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Updated service.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/sms/requests': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List SMS requests across merchants', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, ...paginationParameters], responses: { 200: { description: 'SMS request records.' }, ...commonErrorResponses } },
    },
    '/v1/admin/sms/usage': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List SMS usage across merchants', parameters: [{ name: 'merchantId', in: 'query', schema: { type: 'string', format: 'uuid' } }, ...paginationParameters], responses: { 200: { description: 'SMS usage records.' }, ...commonErrorResponses } },
    },
    '/v1/admin/usage/merchants': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List per-merchant request usage and limits', responses: { 200: { description: 'Usage per merchant with effective limits and current window.' }, ...commonErrorResponses } },
    },
    '/v1/admin/usage/merchants/{merchantId}': {
      get: {
        tags: ['Admin'], security: adminSecurity, summary: 'Read one merchant request usage and limits',
        parameters: [{ name: 'merchantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Merchant usage detail.' }, ...commonErrorResponses },
      },
      put: {
        tags: ['Admin'], security: adminSecurity, summary: 'Set one merchant request rate limits',
        parameters: [{ name: 'merchantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { generalRequestsPerMinute: { type: 'integer', nullable: true, minimum: 0 }, aiRequestsPerMinute: { type: 'integer', nullable: true, minimum: 0 }, smsRequestsPerMinute: { type: 'integer', nullable: true, minimum: 0 } } } } } },
        responses: { 200: { description: 'Updated merchant limits.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/webhook-deliveries': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List webhook deliveries across merchants', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, ...paginationParameters], responses: { 200: { description: 'Delivery records (endpoint origin only, no secrets).' }, ...commonErrorResponses } },
    },
    '/v1/admin/webhook-deliveries/{deliveryId}/attempts': {
      get: {
        tags: ['Admin'], security: adminSecurity, summary: 'List delivery attempts for a delivery',
        parameters: [{ name: 'deliveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Attempts with normalized errors.' }, ...commonErrorResponses },
      },
    },
    '/v1/admin/subscriptions': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List subscriptions across merchants', parameters: [...paginationParameters], responses: { 200: { description: 'Subscriptions.' }, ...commonErrorResponses } },
    },
    '/v1/admin/invoices': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List invoices across merchants', parameters: [...paginationParameters], responses: { 200: { description: 'Invoices, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { invoices: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/admin/receipts': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List receipts across merchants', parameters: [...paginationParameters], responses: { 200: { description: 'Receipts, newest first.', content: { 'application/json': { schema: { type: 'object', properties: { receipts: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...paginationProperty } } } } }, ...commonErrorResponses } },
    },
    '/v1/admin/audit-log': {
      get: {
        tags: ['Admin'], security: adminSecurity, summary: 'List every audit-log entry (all actors)',
        parameters: [
          { name: 'actorType', in: 'query', schema: { type: 'string', enum: ['merchant', 'admin'] } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string' } },
          ...paginationParameters,
        ],
        responses: {
          200: { description: 'Audit entries across actors, newest first. Never contains secrets.', content: { 'application/json': { schema: { type: 'object', properties: { entries: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } }, ...paginationProperty } } } } },
          ...commonErrorResponses,
        },
      },
    },
    '/v1/admin/payment-adapters': {
      get: { tags: ['Admin'], security: adminSecurity, summary: 'List installed payment adapter status (no settings)', responses: { 200: { description: 'Adapter id, name, status and capabilities only.' }, ...commonErrorResponses } },
    },
  },
  components: {
    securitySchemes: {
      merchantApiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'Merchant API key sent as `Authorization: Bearer <key>`. Keys are created once via the merchant API or admin provisioning and stored only as hashes. Each key carries scopes such as `orders:read` or `payments:write`; write implies read, and a missing scope returns `403 insufficient_scope`.',
      },
      adminApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-api-key',
        description: 'Server-side administrator credential for operational endpoints. Never embedded in responses and never shown as an example value.',
      },
    },
    schemas: {
      Error: errorSchema,
      Order: orderSchema,
      Payment: paymentSchema,
      Transaction: transactionSchema,
      Customer: customerSchema,
      PaymentLink: paymentLinkSchema,
      AiUsage: aiUsageSchema,
      AuditEntry: auditEntrySchema,
      Pagination: paginationSchema,
      UsageCategory: {
        type: 'object',
        properties: {
          used: { type: 'integer' },
          limit: { type: 'integer', nullable: true, description: 'null when unlimited.' },
          unlimited: { type: 'boolean' },
          remaining: { type: 'integer', nullable: true },
          windowStart: { type: 'string', format: 'date-time' },
          windowResetAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    responses: {
      BadRequest: { description: 'Validation error or invalid filter.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthorized: { description: 'Missing or invalid credentials.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Forbidden: { description: 'The API key lacks the scope required by this route (`insufficient_scope`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NotFound: { description: 'Resource not found or not owned by this merchant.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Conflict: { description: 'Conflicting state or idempotency conflict.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unprocessable: { description: 'Unprocessable request (for example an unsupported feature).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      RateLimited: { description: 'Rate limited (per client address or per merchant limit).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      ServiceUnavailable: { description: 'A required provider is unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      GatewayTimeout: { description: 'A provider request timed out.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
} as const;
