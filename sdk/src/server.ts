import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaymentStatus = 'CREATED' | 'PENDING' | 'DETECTED' | 'VERIFYING' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
export type OrderStatus = 'CREATED' | 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export type CreditTopupStatus = 'PENDING' | 'CREDITED' | 'FAILED' | 'EXPIRED';
export type WebhookEventType =
  | 'payment.created'
  | 'payment.detected'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.expired'
  | 'order.paid'
  | 'credit.topup'
  | 'credit.deducted'
  | 'ai.usage.recorded';

export interface TariffiaClientOptions {
  /** Merchant API key. Keep this server-side and load it from a secret store or environment. */
  apiKey: string;
  /** API origin, for example https://pay.example.com. Defaults to http://localhost:8080. */
  baseUrl?: string;
  /** Optional Fetch-compatible transport for tests, proxies, or custom observability. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface IdempotentRequestOptions extends RequestOptions {
  /** Stable across retries of the same logical request; use a new key for a new action. */
  idempotencyKey: string;
}

export interface CreateOrderInput {
  customerId?: string;
  reference?: string;
  description: string;
  amount: string;
  currency?: 'USDC';
  metadata?: Record<string, unknown>;
}

export interface Order {
  id: string;
  customerId: string | null;
  reference: string | null;
  description: string;
  amount: string;
  currency: 'USDC';
  status: OrderStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: string;
  amountBaseUnits?: string;
  currency: 'USDC';
  adapter?: string;
  network: string;
  recipientAddress?: string;
  tokenAddress?: string | null;
  adapterData?: Record<string, unknown>;
  status: PaymentStatus;
  txHash?: string | null;
  expiresAt?: string | null;
  detectedAt?: string | null;
  confirmedAt?: string | null;
  createdAt?: string;
}

export interface PaymentLinkResult {
  order: Order;
  payment: Payment;
  checkoutUrl: string;
  qrUrl: string;
  creditTopup?: {
    id: string;
    accountId: string;
    customerId: string;
    amountUsdc: string;
    creditAmount: string;
    creditsPerUsdcRate: number;
    status: CreditTopupStatus;
  };
}

export interface PaymentStatusResult {
  payment: Payment & {
    amountBaseUnits: string;
    adapterData: Record<string, unknown>;
  };
}

export interface VerifyPaymentResult {
  payment: {
    status: 'PENDING' | 'DETECTED' | 'CONFIRMED' | 'FAILED';
    transactionHash: string;
    confirmations: number;
    alreadyConfirmed?: boolean;
    alreadyFailed?: boolean;
    failureReason?: string;
  };
}

export interface CreateWebhookEndpointInput {
  name: string;
  url: string;
  events: WebhookEventType[];
  /** The secret is submitted to Tariffia once and is never returned by the API. */
  secret: string;
}

export interface UpdateWebhookEndpointInput {
  name?: string;
  url?: string;
  events?: WebhookEventType[];
  secret?: string;
  enabled?: boolean;
}

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface CreditBalance {
  accountId: string;
  customerId: string;
  balance: string;
  currency: 'CREDITS';
  creditsPerUsdcRate: number;
}

export interface AiModelPricing {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  pricingMode: 'PER_REQUEST' | 'PER_1K_TOKENS' | 'PER_REQUEST_AND_TOKENS';
  pricePerRequestUsd: string;
  inputPricePer1kUsd: string;
  outputPricePer1kUsd: string;
}

export interface RecordAiUsageInput {
  /** Unique per merchant. Reuse it to safely retry the same reported request. */
  requestId: string;
  customerId: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface AiUsageResult {
  usage: {
    id: string;
    requestId: string;
    customerId: string;
    provider: string;
    model: string;
    pricingMode: AiModelPricing['pricingMode'];
    inputTokens: number;
    outputTokens: number;
    customerPriceUsd: string;
    creditsDeducted: string;
    balanceAfter: string;
    currency: 'CREDITS';
    metadata: Record<string, unknown>;
  };
}

export class TariffiaApiError extends Error {
  readonly name = 'TariffiaApiError';

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly responseBody: unknown,
  ) {
    super(message);
  }
}

export class TariffiaProtocolError extends Error {
  readonly name = 'TariffiaProtocolError';

  constructor(message: string, public readonly statusCode: number, public readonly responseText: string) {
    super(message);
  }
}

export class TariffiaClient {
  #apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: TariffiaClientOptions) {
    if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
      throw new Error('TariffiaClient is server-side only. Use @tariffia/pay/browser for checkout navigation.');
    }
    if (!options.apiKey?.trim()) throw new TypeError('A merchant API key is required');
    this.#apiKey = options.apiKey.trim();
    const apiUrl = new URL(options.baseUrl ?? 'http://localhost:8080');
    if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
      throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment');
    }
    this.baseUrl = apiUrl.toString().replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch;
  }

  createOrder(input: CreateOrderInput, options: IdempotentRequestOptions): Promise<PaymentLinkResult> {
    return this.request('/v1/orders', 'POST', input, options, options.idempotencyKey);
  }

  createPaymentLink(input: CreateOrderInput, options: IdempotentRequestOptions): Promise<PaymentLinkResult> {
    return this.request('/v1/payment-links', 'POST', input, options, options.idempotencyKey);
  }

  getPaymentStatus(paymentId: string, options: RequestOptions = {}): Promise<PaymentStatusResult> {
    return this.request(`/v1/payments/${encodeURIComponent(paymentId)}`, 'GET', undefined, options);
  }

  verifyPayment(paymentId: string, transactionHash: string, options: RequestOptions = {}): Promise<VerifyPaymentResult> {
    return this.request(`/v1/payments/${encodeURIComponent(paymentId)}/verify`, 'POST', { transactionHash }, options);
  }

  createWebhookEndpoint(input: CreateWebhookEndpointInput, options: RequestOptions = {}): Promise<{ endpoint: WebhookEndpoint }> {
    return this.request('/v1/webhooks', 'POST', input, options);
  }

  getWebhookEndpoints(options: RequestOptions = {}): Promise<{ endpoints: WebhookEndpoint[] }> {
    return this.request('/v1/webhooks', 'GET', undefined, options);
  }

  updateWebhookEndpoint(endpointId: string, input: UpdateWebhookEndpointInput, options: RequestOptions = {}): Promise<{ endpoint: WebhookEndpoint }> {
    return this.request(`/v1/webhooks/${encodeURIComponent(endpointId)}`, 'PATCH', input, options);
  }

  async deleteWebhookEndpoint(endpointId: string, options: RequestOptions = {}): Promise<void> {
    await this.request<undefined>(`/v1/webhooks/${encodeURIComponent(endpointId)}`, 'DELETE', undefined, options);
  }

  getCustomerCreditBalance(customerId: string, options: RequestOptions = {}): Promise<CreditBalance> {
    return this.request(`/v1/credits/${encodeURIComponent(customerId)}/balance`, 'GET', undefined, options);
  }

  createCreditTopup(input: { customerId: string; amount: string }, options: IdempotentRequestOptions): Promise<PaymentLinkResult> {
    return this.request('/v1/credits/topups', 'POST', input, options, options.idempotencyKey);
  }

  recordAiUsage(input: RecordAiUsageInput, options: RequestOptions = {}): Promise<AiUsageResult> {
    return this.request('/v1/ai/usage', 'POST', input, options);
  }

  getAiModels(options: RequestOptions = {}): Promise<{ models: AiModelPricing[] }> {
    return this.request('/v1/ai/models', 'GET', undefined, options);
  }

  private async request<T>(
    path: string,
    method: string,
    body: unknown,
    options: RequestOptions,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.#apiKey}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;

    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) throw new TariffiaProtocolError('Tariffia API returned a non-JSON success response', response.status, text);
        throw new TariffiaApiError(text, response.status, 'http_error', text);
      }
    }
    if (!response.ok) {
      const errorBody = isRecord(parsed) ? parsed : {};
      throw new TariffiaApiError(
        typeof errorBody.message === 'string' ? errorBody.message : `Tariffia API request failed with status ${response.status}`,
        response.status,
        typeof errorBody.error === 'string' ? errorBody.error : 'request_error',
        parsed,
      );
    }
    return parsed as T;
  }
}

export interface VerifyTariffiaWebhookInput {
  secret: string;
  rawBody: string;
  signatureHeader: string;
  timestampHeader?: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export type WebhookVerificationResult = { valid: true } | { valid: false; reason: string };

/** Verify against the exact UTF-8 request body before parsing its JSON. */
export function verifyWebhookSignature(input: VerifyTariffiaWebhookInput): WebhookVerificationResult {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/i.exec(input.signatureHeader.trim());
  if (!match) return { valid: false, reason: 'Malformed Tariffia signature header' };
  const timestamp = Number(match[1]);
  if (input.timestampHeader !== undefined && Number(input.timestampHeader) !== timestamp) {
    return { valid: false, reason: 'Webhook timestamp header does not match signed timestamp' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'Webhook timestamp is outside the allowed tolerance' };
  }
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.rawBody}`, 'utf8').digest();
  const received = Buffer.from(match[2]!, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'Webhook signature does not match' };
  }
  return { valid: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
