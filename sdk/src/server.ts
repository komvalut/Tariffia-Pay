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
  | 'ai.usage.recorded'
  | 'invoice.issued'
  | 'receipt.issued'
  | 'subscription.created'
  | 'subscription.activated'
  | 'subscription.paused'
  | 'subscription.resumed'
  | 'subscription.cancelled'
  | 'subscription.past_due'
  | 'subscription.expired'
  |   'subscription.billing_cycle.created'
  | 'subscription.billing_cycle.paid'
  | 'subscription.billing_cycle.failed'
  | 'ai.request.completed'
  | 'ai.request.failed'
  | 'sms.request.completed'
  | 'sms.request.failed';

export type SmsRequestKind = 'SMS' | 'OTP';
export type SmsUsageSource = 'provider' | 'estimated';

export interface SmsService {
  service: string;
  name: string;
  type: 'otp_sms';
  pricePerSmsUsd: string;
  maxMessageLength: number;
  providerConfigured: boolean;
  otpLength: number;
  otpExpirySeconds: number;
}

export interface SmsSendInput {
  requestId: string;
  service: string;
  to: string;
  message: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
}

export interface SmsOtpInput {
  requestId: string;
  service: string;
  to: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
}

export interface SmsRequestResult {
  request: {
    id: string;
    requestId: string;
    customerId: string;
    service: string;
    provider: string;
    kind: SmsRequestKind;
    providerRequestId: string;
    providerMessageId: string;
    status: 'sent';
    latencyMs: number;
  };
  usage: {
    id: string;
    requestId: string;
    kind: SmsRequestKind;
    units: number;
    usageSource: SmsUsageSource;
    customerPriceUsd: string;
    creditsDeducted: string;
    balanceAfter: string;
    currency: 'CREDITS';
  };
}

export type AiChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface AiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AiChatCompletionRequest {
  requestId: string;
  customerId: string;
  provider: string;
  model: string;
  messages: Array<{
    role: AiChatRole;
    content: string;
    toolCallId?: string;
    name?: string;
    toolCalls?: AiToolCall[];
  }>;
  maxOutputTokens?: number;
  temperature?: number;
  tools?: AiToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  metadata?: Record<string, unknown>;
}

export interface AiChatCompletionResult {
  request: {
    id: string;
    requestId: string;
    customerId: string;
    provider: string;
    model: string;
    providerRequestId: string;
    providerResponseId: string;
    finishReason: string | null;
    latencyMs: number;
    toolCallCount: number;
    message: { role: 'assistant'; content: string };
    toolCalls?: AiToolCall[];
  };
  usage: {
    id: string;
    requestId: string;
    pricingMode: 'PER_REQUEST' | 'PER_1K_TOKENS' | 'PER_REQUEST_AND_TOKENS';
    inputTokens: number;
    outputTokens: number;
    customerPriceUsd: string;
    creditsDeducted: string;
    balanceAfter: string;
    currency: 'CREDITS';
    usageSource: 'provider' | 'estimated';
  };
}

export type AiStreamClientEvent =
  | { type: 'chunk'; content: string }
  | { type: 'tool_call'; toolCall: AiToolCall }
  | { type: 'finish'; finishReason: string | null }
  | {
    type: 'done';
    request: {
      id: string;
      requestId: string;
      customerId: string;
      provider: string;
      model: string;
      providerRequestId: string;
      providerResponseId: string;
      finishReason: string | null;
      latencyMs: number;
      toolCallCount: number;
      chargeCapped: boolean;
    };
    usage: {
      id: string;
      requestId: string;
      pricingMode: 'PER_REQUEST' | 'PER_1K_TOKENS' | 'PER_REQUEST_AND_TOKENS';
      inputTokens: number;
      outputTokens: number;
      customerPriceUsd: string;
      creditsDeducted: string;
      balanceAfter: string;
      currency: 'CREDITS';
      usageSource: 'provider' | 'estimated';
    };
  }
  | { type: 'error'; error: string; message: string };

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED' | 'PAST_DUE';
export type SubscriptionBillingMode = 'MANUAL' | 'AUTOMATIC';
export type BillingInterval = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

/** Shared pagination metadata returned by every paginated list endpoint (API default limit 50, max 100). */
export interface Pagination {
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
}

/** Shared query parameters for paginated list methods. */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface Customer {
  id: string;
  externalId: string | null;
  email: string | null;
  name: string | null;
  metadata: Record<string, unknown>;
  orderCount?: number;
  paymentCount?: number;
  createdAt: string;
}

export interface CreateCustomerInput {
  externalId?: string;
  email?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderDetail {
  id: string;
  customerId: string | null;
  reference: string | null;
  description: string;
  amount: string;
  currency: string;
  status: OrderStatus;
  statusLabel?: string;
  paymentId?: string | null;
  paymentStatus?: PaymentStatus | null;
  paymentStatusLabel?: string | null;
  network?: string | null;
  transactionId?: string | null;
  detectedAt?: string | null;
  confirmedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Transaction {
  paymentId: string;
  orderId: string;
  description: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  statusLabel: string;
  network: string;
  adapter: string;
  transactionId: string | null;
  transactionHash: string | null;
  detectedAt: string | null;
  confirmedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface PaymentDetailsResult {
  payment: {
    id: string;
    orderId: string;
    amount: string;
    amountBaseUnits: string;
    currency: string;
    status: PaymentStatus;
    statusLabel: string;
    paymentMethod: { id: string; name: string };
    network: string;
    recipientAddress: string;
    tokenAddress: string | null;
    transactionId: string | null;
    transactionHash: string | null;
    detectedAt: string | null;
    confirmedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  };
  order: {
    id: string;
    reference: string | null;
    description: string;
    amount: string;
    currency: string;
    status: OrderStatus;
    customerId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  invoice: Invoice | null;
  receipt: Receipt | null;
}

export interface PaymentLink {
  id: string;
  orderId: string;
  reference: string | null;
  description: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  transactionHash: string | null;
  enabled: boolean;
  disabledAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  checkoutUrl: string;
  qrUrl: string;
}

export interface RevenueSummary {
  currency: string | null;
  totalConfirmed: string | null;
  confirmedPaymentCount: number;
  pendingPaymentCount: number;
  failedPaymentCount: number;
  expiredPaymentCount: number;
  totalsByCurrency: Record<string, string>;
  from: string | null;
  to: string | null;
}

export interface RevenueHistoryEntry {
  date: string;
  currency: string;
  confirmedAmount: string;
  confirmedPaymentCount: number;
}

export interface RevenueHistoryResult {
  history: RevenueHistoryEntry[];
  from: string | null;
  to: string | null;
  currency: string | null;
}

export type MerchantUsageCategory = 'general' | 'ai' | 'sms';

export interface MerchantUsageCategorySummary {
  used: number;
  limit: number | null;
  unlimited: boolean;
  remaining: number | null;
  windowStart: string;
  windowResetAt: string;
}

export type MerchantUsageSummary = Record<MerchantUsageCategory, MerchantUsageCategorySummary>;

export interface MerchantSettings {
  merchantId: string;
  displayName: string | null;
  supportEmail: string | null;
  defaultCurrency: string;
  timezone: string;
  updatedAt: string | null;
}

export interface UpdateMerchantSettingsInput {
  displayName?: string | null;
  supportEmail?: string | null;
  defaultCurrency?: string | null;
  timezone?: string | null;
}

export interface NotificationPreferences {
  paymentConfirmed: boolean;
  paymentFailed: boolean;
  paymentExpired: boolean;
  creditTopup: boolean;
  aiRequestFailed: boolean;
  smsRequestFailed: boolean;
  webhookFailed: boolean;
  updatedAt: string | null;
}

export type UpdateNotificationPreferencesInput = Omit<NotificationPreferences, 'updatedAt'>;

export type ApiKeyStatus = 'active' | 'revoked';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  /** Returned exactly once by the API; store it securely and never log it. */
  secret: string;
  warning: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  event: string;
  status: 'QUEUED' | 'DELIVERING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  nextAttemptAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actorType: 'merchant' | 'admin';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type DashboardCollection =
  | 'customers'
  | 'orders'
  | 'payments'
  | 'payment-links'
  | 'credit-accounts'
  | 'credit-transactions'
  | 'topups'
  | 'usage'
  | 'webhook-endpoints'
  | 'webhook-deliveries';

export interface DashboardOverview {
  customers: number;
  orders: number;
  pending_payments: number;
  failed_or_expired_payments: number;
  usdc_received: string;
  credit_accounts: number;
  credit_balance_units: string;
  ai_requests: number;
  ai_usage_cost_usd: string;
  failed_webhook_deliveries: number;
}

export interface DashboardCollectionQuery extends PaginationOptions {
  q?: string;
  status?: string;
}

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
  currency?: string;
  adapter?: string;
  metadata?: Record<string, unknown>;
}

export interface Order {
  id: string;
  customerId: string | null;
  reference: string | null;
  description: string;
  amount: string;
  currency: string;
  status: OrderStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: string;
  amountBaseUnits?: string;
  currency: string;
  adapter?: string;
  paymentMethod?: {
    id: string;
    name: string;
    paymentRequestFormat: 'wallet' | 'invoice';
  };
  paymentRequest?: string | null;
  network: string;
  recipientAddress?: string;
  tokenAddress?: string | null;
  status: PaymentStatus;
  txHash?: string | null;
  transactionId?: string | null;
  expiresAt?: string | null;
  detectedAt?: string | null;
  confirmedAt?: string | null;
  createdAt?: string;
}

export interface PaymentMethodOption {
  id: string;
  name: string;
  description: string;
  capabilities: {
    paymentRequests: boolean;
    transactionVerification: boolean;
    statusPolling: boolean;
    recurringPayments: boolean;
    automaticDetection: boolean;
    refunds: boolean;
    paymentRequestFormat: 'wallet' | 'invoice';
    currencies: string[];
    networks: string[];
  };
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  merchantId: string;
  customerId: string | null;
  orderId: string;
  paymentId: string;
  amount: string;
  currency: string;
  paymentMethod: { id: string; name: string };
  network: string;
  paymentStatus: 'CONFIRMED';
  transactionId: string;
  paidAt: string;
  merchant: { name: string; email: string };
  customer: { id: string; name: string | null; email: string | null } | null;
  orderReference: string | null;
  description: string;
  receipt: { id: string; publicId: string; issuedAt: string; publicUrl: string };
  createdAt: string;
}

export interface Receipt {
  id: string;
  publicId: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  orderId: string;
  amount: string;
  currency: string;
  paymentMethod: { id: string; name: string };
  network: string;
  paymentStatus: 'CONFIRMED';
  transactionId: string;
  paidAt: string;
  issuedAt: string;
  merchant: { name: string; email: string };
  customer: { id: string; name: string | null; email: string | null } | null;
  orderReference: string | null;
  description: string;
  publicUrl: string;
}

export interface PublicReceipt {
  invoiceNumber: string;
  merchantName: string;
  description: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  network: string;
  paymentStatus: 'CONFIRMED';
  transactionId: string;
  paidAt: string;
  issuedAt: string;
}

export interface SubscriptionPlanInput {
  name: string;
  description?: string;
  amount: string;
  currency?: string;
  interval: BillingInterval;
  intervalCount?: number;
  trialDays?: number;
  enabled?: boolean;
}

export interface SubscriptionPlan extends Required<Omit<SubscriptionPlanInput, 'description' | 'currency' | 'intervalCount' | 'trialDays' | 'enabled'>> {
  id: string;
  merchantId: string;
  description: string;
  currency: string;
  intervalCount: number;
  trialDays: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  merchantId: string;
  customerId: string;
  customer: { name: string | null; email: string | null };
  planId: string;
  planName: string;
  paymentMethod: { id: string; name: string };
  billingMode: SubscriptionBillingMode;
  automaticRenewalAvailable: boolean;
  amount: string;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  trialDays: number;
  status: SubscriptionStatus;
  startsAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextBillingAt: string;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionBillingAttempt {
  id: string;
  billingCycleId: string;
  attemptNumber: number;
  orderId: string | null;
  paymentId: string | null;
  status: 'CREATING' | 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SubscriptionBillingCycle {
  id: string;
  subscriptionId: string;
  cycleNumber: number;
  periodStart: string;
  periodEnd: string;
  amount: string;
  currency: string;
  status: 'CREATING' | 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  paidAt: string | null;
  attempts: SubscriptionBillingAttempt[];
  createdAt: string;
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
  };
}

export interface VerifyPaymentResult {
  payment: {
    status: 'PENDING' | 'DETECTED' | 'CONFIRMED' | 'FAILED';
    transactionId: string;
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

/**
 * Machine-readable error codes returned by the Tariffia API in the `error`
 * field of an error response. This union covers the codes the current API
 * emits plus client-side transport fallbacks. It is intentionally open: an
 * unrecognized code from a newer server is still surfaced (as the raw string)
 * so nothing is swallowed.
 */
export const TARIFFIA_API_ERROR_CODES = [
  // Authentication / authorization
  'unauthorized',
  'insufficient_scope',
  'forbidden',
  // Validation / pagination / request shape
  'validation_error',
  'bad_request',
  'invalid_pagination',
  'invalid_path_parameter',
  'missing_idempotency_key',
  'invalid_idempotency_key',
  'idempotency_conflict',
  'invalid_order_status',
  'invalid_transaction_status',
  'invalid_transaction_network',
  'invalid_currency',
  'invalid_date_range',
  'invalid_webhook_url',
  'invalid_subscription_state',
  'invalid_subscription_end_date',
  // Resources
  'not_found',
  'merchant_not_found',
  'customer_not_found',
  'subscription_not_found',
  'subscription_plan_not_found',
  'subscription_attempt_not_found',
  'ai_provider_not_found',
  'ai_model_not_found',
  'sms_provider_not_found',
  'sms_service_not_found',
  // State / money / usage
  'conflict',
  'insufficient_credits',
  'zero_usage_price',
  'zero_sms_usage_price',
  'topup_below_minimum',
  'topup_above_maximum',
  'sms_request_conflict',
  'sms_request_in_progress',
  'sms_request_already_settled',
  'subscription_expired',
  'subscription_renewal_not_due',
  'recurring_unavailable',
  'payment_method_currency_unsupported',
  // Availability / limits / transport
  'rate_limited',
  'merchant_rate_limited',
  'adapter_unavailable',
  'sms_settlement_failed',
  'service_unavailable',
  // Client-side fallbacks (never sent by the server)
  'request_error',
  'http_error',
] as const;

export type TariffiaApiErrorCode = (typeof TARIFFIA_API_ERROR_CODES)[number];

const TARIFFIA_API_ERROR_CODE_SET: ReadonlySet<string> = new Set(TARIFFIA_API_ERROR_CODES);

/** Preserves any server code; narrows to the known union when recognized. */
export function isTariffiaApiErrorCode(value: string): value is TariffiaApiErrorCode {
  return TARIFFIA_API_ERROR_CODE_SET.has(value);
}

export class TariffiaApiError extends Error {
  readonly name = 'TariffiaApiError';

  constructor(
    message: string,
    public readonly statusCode: number,
    /**
     * The machine-readable error code. Values known to Tariffia are members of
     * {@link TariffiaApiErrorCode}; a code from a newer server is preserved as a
     * raw string rather than being dropped.
     */
    public readonly code: TariffiaApiErrorCode | (string & {}),
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

  // --- Customers -----------------------------------------------------------

  getCustomers(query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ customers: Customer[]; pagination: Pagination }> {
    return this.request(`/v1/customers${this.paginationQuery(query)}`, 'GET', undefined, options);
  }

  getCustomer(customerId: string, options: RequestOptions = {}): Promise<{ customer: Customer }> {
    return this.request(`/v1/customers/${encodeURIComponent(customerId)}`, 'GET', undefined, options);
  }

  /** Idempotent create/update. Repeating the same email/externalId returns the existing customer. */
  createCustomer(input: CreateCustomerInput, options: RequestOptions = {}): Promise<{ customer: Customer }> {
    return this.request('/v1/customers', 'POST', input, options);
  }

  // --- Orders and payments -------------------------------------------------

  getOrders(query: { status?: OrderStatus } & PaginationOptions = {}, options: RequestOptions = {}): Promise<{ orders: OrderDetail[]; pagination: Pagination }> {
    return this.request(`/v1/orders${this.query({ status: query.status, ...query })}`, 'GET', undefined, options);
  }

  getOrder(orderId: string, options: RequestOptions = {}): Promise<{ order: OrderDetail }> {
    return this.request(`/v1/orders/${encodeURIComponent(orderId)}`, 'GET', undefined, options);
  }

  getTransactions(query: { status?: PaymentStatus; network?: string } & PaginationOptions = {}, options: RequestOptions = {}): Promise<{ transactions: Transaction[]; pagination: Pagination }> {
    return this.request(`/v1/transactions${this.query(query)}`, 'GET', undefined, options);
  }

  getTransaction(paymentId: string, options: RequestOptions = {}): Promise<{ transaction: Transaction }> {
    return this.request(`/v1/transactions/${encodeURIComponent(paymentId)}`, 'GET', undefined, options);
  }

  getPaymentDetails(paymentId: string, options: RequestOptions = {}): Promise<PaymentDetailsResult> {
    return this.request(`/v1/payments/${encodeURIComponent(paymentId)}/details`, 'GET', undefined, options);
  }

  // --- Payment links -------------------------------------------------------

  getPaymentLinks(query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ paymentLinks: PaymentLink[]; pagination: Pagination }> {
    return this.request(`/v1/payment-links${this.paginationQuery(query)}`, 'GET', undefined, options);
  }

  getPaymentLink(paymentId: string, options: RequestOptions = {}): Promise<{ paymentLink: PaymentLink }> {
    return this.request(`/v1/payment-links/${encodeURIComponent(paymentId)}`, 'GET', undefined, options);
  }

  /** Enables or disables a hosted payment link. Does not affect the underlying payment record. */
  updatePaymentLink(paymentId: string, input: { enabled: boolean }, options: RequestOptions = {}): Promise<{ paymentLink: PaymentLink }> {
    return this.request(`/v1/payment-links/${encodeURIComponent(paymentId)}`, 'PATCH', input, options);
  }

  async deletePaymentLink(paymentId: string, options: RequestOptions = {}): Promise<void> {
    await this.request<undefined>(`/v1/payment-links/${encodeURIComponent(paymentId)}`, 'DELETE', undefined, options);
  }

  // --- Revenue -------------------------------------------------------------

  getRevenueSummary(query: { from?: string; to?: string } = {}, options: RequestOptions = {}): Promise<{ revenue: RevenueSummary }> {
    return this.request(`/v1/revenue/summary${this.query(query)}`, 'GET', undefined, options);
  }

  getRevenueHistory(query: { from?: string; to?: string; currency?: string } = {}, options: RequestOptions = {}): Promise<RevenueHistoryResult> {
    return this.request(`/v1/revenue/history${this.query(query)}`, 'GET', undefined, options);
  }

  // --- Usage, settings and notifications -----------------------------------

  getUsage(options: RequestOptions = {}): Promise<{ usage: MerchantUsageSummary }> {
    return this.request('/v1/usage', 'GET', undefined, options);
  }

  getSettings(options: RequestOptions = {}): Promise<{ settings: MerchantSettings }> {
    return this.request('/v1/settings', 'GET', undefined, options);
  }

  updateSettings(input: UpdateMerchantSettingsInput, options: RequestOptions = {}): Promise<{ settings: MerchantSettings }> {
    return this.request('/v1/settings', 'PUT', input, options);
  }

  getNotificationPreferences(options: RequestOptions = {}): Promise<{ preferences: NotificationPreferences }> {
    return this.request('/v1/notification-preferences', 'GET', undefined, options);
  }

  updateNotificationPreferences(input: UpdateNotificationPreferencesInput, options: RequestOptions = {}): Promise<{ preferences: NotificationPreferences }> {
    return this.request('/v1/notification-preferences', 'PUT', input, options);
  }

  // --- API keys ------------------------------------------------------------

  getApiKeys(options: RequestOptions = {}): Promise<{ apiKeys: ApiKey[] }> {
    return this.request('/v1/api-keys', 'GET', undefined, options);
  }

  /** The plaintext secret is returned only in this response; never store or log it beyond the response. */
  createApiKey(input: { name: string; scopes?: string[] }, options: RequestOptions = {}): Promise<CreatedApiKey> {
    return this.request('/v1/api-keys', 'POST', input, options);
  }

  async revokeApiKey(keyId: string, options: RequestOptions = {}): Promise<void> {
    await this.request<undefined>(`/v1/api-keys/${encodeURIComponent(keyId)}`, 'DELETE', undefined, options);
  }

  // --- Audit log -----------------------------------------------------------

  getAuditLog(query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ entries: AuditEntry[]; pagination: Pagination }> {
    return this.request(`/v1/audit-log${this.paginationQuery(query)}`, 'GET', undefined, options);
  }

  // --- Dashboard -----------------------------------------------------------

  getDashboardOverview(options: RequestOptions = {}): Promise<{ overview: DashboardOverview }> {
    return this.request('/v1/dashboard/overview', 'GET', undefined, options);
  }

  getDashboardCollection(
    collection: DashboardCollection,
    query: DashboardCollectionQuery = {},
    options: RequestOptions = {},
  ): Promise<{ items: Array<Record<string, unknown>>; pagination: Pagination }> {
    return this.request(`/v1/dashboard/${encodeURIComponent(collection)}${this.query(query)}`, 'GET', undefined, options);
  }

  getPaymentMethods(options: RequestOptions = {}): Promise<{ methods: PaymentMethodOption[] }> {
    return this.request('/v1/public/payment-methods', 'GET', undefined, options);
  }

  createSubscriptionPlan(input: SubscriptionPlanInput, options: RequestOptions = {}): Promise<{ plan: SubscriptionPlan }> {
    return this.request('/v1/subscription-plans', 'POST', input, options);
  }

  getSubscriptionPlans(options: RequestOptions = {}): Promise<{ plans: SubscriptionPlan[] }> {
    return this.request('/v1/subscription-plans', 'GET', undefined, options);
  }

  updateSubscriptionPlan(planId: string, input: Partial<SubscriptionPlanInput>, options: RequestOptions = {}): Promise<{ plan: SubscriptionPlan }> {
    return this.request(`/v1/subscription-plans/${encodeURIComponent(planId)}`, 'PUT', input, options);
  }

  createSubscription(input: {
    planId: string;
    customerId: string;
    adapter?: string;
    billingMode?: SubscriptionBillingMode;
    endsAt?: string;
  }, options: IdempotentRequestOptions): Promise<{
    subscription: Subscription;
    billingCycles: SubscriptionBillingCycle[];
    payment: Payment | null;
    order: Order | null;
    checkoutUrl: string | null;
    qrUrl: string | null;
  }> {
    return this.request('/v1/subscriptions', 'POST', input, options, options.idempotencyKey);
  }

  getSubscriptions(options: RequestOptions = {}): Promise<{ subscriptions: Subscription[] }> {
    return this.request('/v1/subscriptions', 'GET', undefined, options);
  }

  getSubscription(subscriptionId: string, options: RequestOptions = {}): Promise<{ subscription: Subscription }> {
    return this.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, 'GET', undefined, options);
  }

  updateSubscription(
    subscriptionId: string,
    action: 'pause' | 'resume' | 'cancel',
    options: RequestOptions = {},
  ): Promise<{ subscription: Subscription }> {
    return this.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, 'PATCH', { action }, options);
  }

  renewSubscription(
    subscriptionId: string,
    options: IdempotentRequestOptions,
  ): Promise<{ subscription: Subscription; billingCycles: SubscriptionBillingCycle[]; payment?: Payment; order?: Order; checkoutUrl?: string; qrUrl?: string }> {
    return this.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/renew`, 'POST', {}, options, options.idempotencyKey);
  }

  getSubscriptionBillingCycles(subscriptionId: string, options: RequestOptions = {}): Promise<{ billingCycles: SubscriptionBillingCycle[] }> {
    return this.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/billing-cycles`, 'GET', undefined, options);
  }

  getCustomerSubscriptions(customerId: string, options: RequestOptions = {}): Promise<{ subscriptions: Subscription[] }> {
    return this.request(`/v1/customers/${encodeURIComponent(customerId)}/subscriptions`, 'GET', undefined, options);
  }

  createChatCompletion(input: AiChatCompletionRequest, options: RequestOptions = {}): Promise<AiChatCompletionResult> {
    return this.request('/v1/ai/chat/completions', 'POST', input, options);
  }

  /**
   * Streams a chat completion over server-sent events. Chunks arrive as they are
   * generated; the terminal `done` event carries the settled usage and charge.
   * Streaming chunks are never authoritative billing data.
   */
  async *streamChatCompletion(input: AiChatCompletionRequest, options: RequestOptions = {}): AsyncGenerator<AiStreamClientEvent> {
    const response = await this.rawRequest('/v1/ai/chat/stream', 'POST', input, options);
    if (!response.body) throw new Error('The streaming response has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
        const line = frame.split('\n').find((entry) => entry.startsWith('data:'));
        if (!line) continue;
        yield JSON.parse(line.slice(5).trim()) as AiStreamClientEvent;
      }
    }
  }

  getSmsServices(options: RequestOptions = {}): Promise<{ services: SmsService[] }> {
    return this.request('/v1/sms/services', 'GET', undefined, options);
  }

  sendSms(input: SmsSendInput, options: RequestOptions = {}): Promise<SmsRequestResult> {
    return this.request('/v1/sms/send', 'POST', input, options);
  }

  sendOtp(input: SmsOtpInput, options: RequestOptions = {}): Promise<SmsRequestResult> {
    return this.request('/v1/sms/otp', 'POST', input, options);
  }

  getInvoices(query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ invoices: Invoice[]; pagination: Pagination }> {
    return this.request(`/v1/invoices${this.paginationQuery(query)}`, 'GET', undefined, options);
  }

  getInvoice(invoiceIdOrNumber: string, options: RequestOptions = {}): Promise<{ invoice: Invoice }> {
    return this.request(`/v1/invoices/${encodeURIComponent(invoiceIdOrNumber)}`, 'GET', undefined, options);
  }

  getInvoicePdf(invoiceIdOrNumber: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.requestPdf(`/v1/invoices/${encodeURIComponent(invoiceIdOrNumber)}.pdf`, options);
  }

  getReceipts(query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ receipts: Receipt[]; pagination: Pagination }> {
    return this.request(`/v1/receipts${this.paginationQuery(query)}`, 'GET', undefined, options);
  }

  getReceipt(receiptIdOrInvoiceNumber: string, options: RequestOptions = {}): Promise<{ receipt: Receipt }> {
    return this.request(`/v1/receipts/${encodeURIComponent(receiptIdOrInvoiceNumber)}`, 'GET', undefined, options);
  }

  getReceiptPdf(receiptIdOrInvoiceNumber: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.requestPdf(`/v1/receipts/${encodeURIComponent(receiptIdOrInvoiceNumber)}.pdf`, options);
  }

  getPublicReceipt(publicId: string, options: RequestOptions = {}): Promise<{ receipt: PublicReceipt }> {
    return this.request(`/v1/public/receipts/${encodeURIComponent(publicId)}`, 'GET', undefined, options);
  }

  getPublicReceiptPdf(publicId: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.requestPdf(`/v1/public/receipts/${encodeURIComponent(publicId)}.pdf`, options);
  }

  getPaymentStatus(paymentId: string, options: RequestOptions = {}): Promise<PaymentStatusResult> {
    return this.request(`/v1/payments/${encodeURIComponent(paymentId)}`, 'GET', undefined, options);
  }

  verifyPayment(paymentId: string, transactionId: string, options: RequestOptions = {}): Promise<VerifyPaymentResult> {
    return this.request(`/v1/payments/${encodeURIComponent(paymentId)}/verify`, 'POST', { transactionId }, options);
  }

  createWebhookEndpoint(input: CreateWebhookEndpointInput, options: RequestOptions = {}): Promise<{ endpoint: WebhookEndpoint }> {
    return this.request('/v1/webhooks', 'POST', input, options);
  }

  getWebhookEndpoints(query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ endpoints: WebhookEndpoint[]; pagination: Pagination }> {
    return this.request(`/v1/webhooks${this.paginationQuery(query)}`, 'GET', undefined, options);
  }

  updateWebhookEndpoint(endpointId: string, input: UpdateWebhookEndpointInput, options: RequestOptions = {}): Promise<{ endpoint: WebhookEndpoint }> {
    return this.request(`/v1/webhooks/${encodeURIComponent(endpointId)}`, 'PATCH', input, options);
  }

  async deleteWebhookEndpoint(endpointId: string, options: RequestOptions = {}): Promise<void> {
    await this.request<undefined>(`/v1/webhooks/${encodeURIComponent(endpointId)}`, 'DELETE', undefined, options);
  }

  getWebhookDeliveries(endpointId: string, query: PaginationOptions = {}, options: RequestOptions = {}): Promise<{ deliveries: WebhookDelivery[]; pagination: Pagination }> {
    return this.request(`/v1/webhooks/${encodeURIComponent(endpointId)}/deliveries${this.paginationQuery(query)}`, 'GET', undefined, options);
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

  private paginationQuery(query: PaginationOptions): string {
    return this.query({ limit: query.limit, offset: query.offset });
  }

  /** Builds an encoded query string, omitting undefined/null/empty values. */
  private query(params: object): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  }

  private async request<T>(
    path: string,
    method: string,
    body: unknown,
    options: RequestOptions,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.rawRequest(path, method, body, options, idempotencyKey);
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

  private async rawRequest(
    path: string,
    method: string,
    body: unknown,
    options: RequestOptions,
    idempotencyKey?: string,
  ): Promise<Response> {
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
    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) as unknown : undefined; } catch { parsed = text; }
      const errorBody = isRecord(parsed) ? parsed : {};
      throw new TariffiaApiError(
        typeof errorBody.message === 'string' ? errorBody.message : `Tariffia API request failed with status ${response.status}`,
        response.status,
        typeof errorBody.error === 'string' ? errorBody.error : 'request_error',
        parsed,
      );
    }
    return response;
  }

  private async requestPdf(path: string, options: RequestOptions): Promise<Uint8Array> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/pdf', authorization: `Bearer ${this.#apiKey}` },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) as unknown : undefined; } catch { body = undefined; }
      const errorBody = isRecord(body) ? body : {};
      throw new TariffiaApiError(
        typeof errorBody.message === 'string' ? errorBody.message : `Tariffia API request failed with status ${response.status}`,
        response.status,
        typeof errorBody.error === 'string' ? errorBody.error : 'request_error',
        body,
      );
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/pdf') {
      const text = await response.text();
      throw new TariffiaProtocolError('Tariffia API did not return a PDF response', response.status, text);
    }
    return new Uint8Array(await response.arrayBuffer());
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
