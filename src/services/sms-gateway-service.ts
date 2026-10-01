import { randomInt } from 'node:crypto';
import { formatUnits } from 'viem';
import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { newId } from '../security.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import {
  SmsProviderError,
  normalizeSmsProviderError,
  smsProviderErrorCode,
  smsProviderErrorMessage,
  type SmsDeliveryResult,
  type SmsProvider,
} from '../sms-provider.js';
import type { SmsProviderRegistry } from '../sms-providers/registry.js';
import { deductUsageCreditsInTransaction } from './usage-settlement.js';
import {
  calculateSmsUsagePrice,
  creditUnitsForPrice,
  customerAiPricesPerUnit,
  usdFromUnits,
  usdToUnits,
  type AiPricingEngine,
  type AiPricingModel,
} from './ai-pricing-engine.js';

export type SmsRequestKind = 'SMS' | 'OTP';

export type SmsSendRequest = {
  merchantId: string;
  requestId: string;
  service: string;
  to: string;
  message: string;
  customerId?: string;
  metadata: Record<string, unknown>;
};

export type SmsOtpRequest = {
  merchantId: string;
  requestId: string;
  service: string;
  to: string;
  customerId?: string;
  metadata: Record<string, unknown>;
};

type SmsServiceRecord = {
  service_id: string;
  service_slug: string;
  service_name: string;
  type: 'otp_sms';
  provider_id: string;
  provider_slug: string;
  fallback_provider_id: string | null;
  fallback_provider_slug: string | null;
  fallback_provider_enabled: boolean | null;
  customer_price_per_sms_usd: string | null;
  provider_cost_per_sms_usd: string;
  markup_bps: number;
  otp_length: number;
  otp_expiry_seconds: number;
  otp_message_template: string;
  max_message_length: number;
};

const serviceFields = `s.id AS service_id, s.slug AS service_slug, s.name AS service_name, s.type,
  s.provider_id, p.slug AS provider_slug,
  s.fallback_provider_id, fp.slug AS fallback_provider_slug, fp.enabled AS fallback_provider_enabled,
  s.customer_price_per_sms_usd::text AS customer_price_per_sms_usd,
  s.provider_cost_per_sms_usd::text AS provider_cost_per_sms_usd, s.markup_bps,
  s.otp_length, s.otp_expiry_seconds, s.otp_message_template, s.max_message_length`;

const serviceJoin = `sms_services s JOIN sms_providers p ON p.id = s.provider_id
  LEFT JOIN sms_providers fp ON fp.id = s.fallback_provider_id`;

/**
 * Audit trail of every pre-acceptance provider attempt. Provider slugs, outcomes,
 * error categories, retry hints and latencies only — never message content or codes.
 */
export type SmsProviderAttempt = {
  provider: string;
  outcome: 'skipped_unconfigured' | 'skipped_unhealthy' | 'failed';
  failureKind: string;
  retryAfterMs: number | null;
  latencyMs: number | null;
  at: string;
};

const BASIC_GSM_CHARS = new Set([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
  'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', 'Æ', 'æ', 'ß', 'É', ' ',
  '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?', '¡',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'Ä', 'Ö', 'Ñ', 'Ü', '§',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'ä', 'ö', 'ñ', 'ü', 'à',
]);

/**
 * Deterministic upper-bound segment estimate. Any character outside the basic GSM 7-bit
 * alphabet is treated as UCS-2, so the estimate never falls below what a provider charges.
 * The estimate only bounds the pre-authorization; provider-reported counts settle the charge.
 */
export function estimateSmsSegments(message: string): number {
  const characters = [...message];
  const gsm = characters.every((character) => BASIC_GSM_CHARS.has(character));
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  if (characters.length === 0) return 1;
  return characters.length <= single ? 1 : Math.ceil(characters.length / multi);
}

function generateOtpCode(length: number): string {
  let code = '';
  for (let index = 0; index < length; index += 1) code += randomInt(0, 10);
  return code;
}

function smsPricingModel(service: SmsServiceRecord): AiPricingModel {
  return {
    pricing_mode: 'PER_REQUEST',
    provider_cost_per_request_usd: service.provider_cost_per_sms_usd,
    customer_price_per_request_usd: service.customer_price_per_sms_usd,
    provider_input_cost_per_1k_usd: '0.00000000',
    customer_input_price_per_1k_usd: '0.00000000',
    provider_output_cost_per_1k_usd: '0.00000000',
    customer_output_price_per_1k_usd: '0.00000000',
    markup_bps: service.markup_bps,
  };
}

export function smsServiceCustomerPrice(service: SmsServiceRecord): string {
  return customerAiPricesPerUnit(smsPricingModel(service)).requestUsd;
}

export class SmsGatewayService {
  constructor(
    private readonly db: Database,
    private readonly pricing: AiPricingEngine,
    private readonly providers: SmsProviderRegistry,
  ) {}

  async listServices() {
    const result = await this.db.query<SmsServiceRecord>(
      `SELECT ${serviceFields}
         FROM ${serviceJoin}
        WHERE s.enabled = true AND p.enabled = true ORDER BY s.name ASC`,
    );
    return { services: result.rows.map((service) => ({
      service: service.service_slug,
      name: service.service_name,
      type: service.type,
      pricePerSmsUsd: smsServiceCustomerPrice(service),
      maxMessageLength: service.max_message_length,
      providerConfigured: this.providers.isConfigured(service.provider_slug),
      ...(service.type === 'otp_sms' ? {
        otpLength: service.otp_length,
        otpExpirySeconds: service.otp_expiry_seconds,
      } : {}),
    })) };
  }

  async sendSms(input: SmsSendRequest) {
    return this.deliver({
      kind: 'SMS',
      merchantId: input.merchantId,
      requestId: input.requestId,
      serviceSlug: input.service,
      to: input.to,
      customerId: input.customerId,
      metadata: input.metadata,
      renderMessage: (service) => {
        if (input.message.length > service.max_message_length) {
          throw new HttpError(413, 'The message exceeds the service maximum length', 'sms_message_too_long');
        }
        return input.message;
      },
    });
  }

  async sendOtp(input: SmsOtpRequest) {
    return this.deliver({
      kind: 'OTP',
      merchantId: input.merchantId,
      requestId: input.requestId,
      serviceSlug: input.service,
      to: input.to,
      customerId: input.customerId,
      metadata: input.metadata,
      renderMessage: (service) => {
        const rendered = service.otp_message_template.replace(/\{code\}/g, () => generateOtpCode(service.otp_length));
        if (rendered.length > service.max_message_length) {
          throw new HttpError(413, 'The OTP message exceeds the service maximum length', 'sms_message_too_long');
        }
        return rendered;
      },
    });
  }

  private async deliver(input: {
    kind: SmsRequestKind;
    merchantId: string;
    requestId: string;
    serviceSlug: string;
    to: string;
    customerId?: string;
    metadata: Record<string, unknown>;
    renderMessage: (service: SmsServiceRecord) => string;
  }) {
    const customerId = await this.resolveCustomerId(input.merchantId, input.customerId);

    // Authorize the worst case before any provider call, then settle only the delivered units.
    const authorization = await this.authorize({ ...input, customerId });
    const dispatched = await this.dispatch(input, authorization);
    if (!dispatched.accepted) {
      await this.failRequest(authorization.providerRequestId, dispatched.error, 0, {
        attempts: dispatched.attempts,
      });
      throw this.toHttpError(dispatched.error);
    }

    const { acceptingProvider, delivery, attempts, latencyMs } = dispatched;
    const units = delivery.segmentsAuthoritative ? delivery.segments : authorization.estimatedUnits;
    try {
      return await this.settle(authorization, {
        units,
        usageAuthoritative: delivery.segmentsAuthoritative,
        providerRequestId: delivery.providerRequestId,
        providerMessageId: delivery.providerMessageId,
        providerCostUsd: delivery.providerCostUsd,
        latencyMs,
        acceptingProvider,
        attempts,
      });
    } catch (error) {
      // Bounded settlement errors (insufficient credits at settle time, a concurrently
      // settled request) stay client-facing as-is; only unexpected settlement failures
      // are normalized so raw internals never reach the merchant.
      if (error instanceof HttpError) throw error;
      // Settlement failed after the provider accepted: fail the request, emit no successful
      // usage charge and report a canonical error.
      await this.failRequest(authorization.providerRequestId, error, latencyMs, {
        attempts,
        failureKind: 'settlement_failed',
        failureMessage: 'The SMS request completed but its usage charge could not be settled',
      });
      throw new HttpError(503, 'The SMS request completed but its usage charge could not be settled', 'sms_settlement_failed');
    }
  }

  /**
   * Selects the provider for a service: the configured primary, then the explicitly
   * configured fallback. Disabled, unconfigured and unhealthy providers never receive
   * the request. A fallback is attempted only after a provider failure that is provably
   * safe to retry; ambiguous outcomes (a timeout without provider idempotency guarantees,
   * rejected destinations, invalid requests, unparseable accepted responses) never fall
   * back, because duplicate delivery cannot be ruled out.
   */
  private async dispatch(
    input: { kind: SmsRequestKind; requestId: string; to: string },
    authorization: Awaited<ReturnType<SmsGatewayService['authorize']>>,
  ): Promise<
    | {
      accepted: true;
      acceptingProvider: { id: string; slug: string };
      delivery: SmsDeliveryResult;
      attempts: SmsProviderAttempt[];
      latencyMs: number;
    }
    | { accepted: false; error: unknown; attempts: SmsProviderAttempt[] }
  > {
    const { service, message } = authorization;
    const candidates = [
      { id: service.provider_id, slug: service.provider_slug },
      ...(service.fallback_provider_id && service.fallback_provider_slug && service.fallback_provider_enabled
        ? [{ id: service.fallback_provider_id, slug: service.fallback_provider_slug }]
        : []),
    ];
    const attempts: SmsProviderAttempt[] = [];
    let lastError: unknown;
    for (const candidate of candidates) {
      let provider: SmsProvider;
      try {
        provider = this.providers.getConfiguredProvider(candidate.slug);
      } catch (error) {
        attempts.push(this.attempt(candidate.slug, 'skipped_unconfigured', error));
        lastError = error;
        continue;
      }

      const health = await this.providers.health(candidate.slug);
      await this.recordProviderHealth(candidate.id, health);
      if (health.status !== 'healthy') {
        const error = new SmsProviderError(
          'unavailable', candidate.slug, 'The SMS provider is not healthy', false, 503,
        );
        attempts.push({
          provider: candidate.slug,
          outcome: 'skipped_unhealthy',
          failureKind: `unhealthy_${health.status}`,
          retryAfterMs: null,
          latencyMs: null,
          at: new Date().toISOString(),
        });
        lastError = error;
        continue;
      }

      const startedAt = Date.now();
      try {
        const delivery = input.kind === 'OTP' && provider.manifest.capabilities.sendOtp && provider.sendOtp
          ? await provider.sendOtp({
            requestId: input.requestId,
            idempotencyKey: input.requestId,
            to: input.to,
            codeLength: service.otp_length,
            expirySeconds: service.otp_expiry_seconds,
          })
          : await provider.sendSms({
            requestId: input.requestId,
            idempotencyKey: input.requestId,
            to: input.to,
            message,
          });
        return {
          accepted: true,
          acceptingProvider: candidate,
          delivery,
          attempts,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        const normalized = normalizeSmsProviderError(error, candidate.slug);
        attempts.push({
          provider: candidate.slug,
          outcome: 'failed',
          failureKind: normalized.kind,
          retryAfterMs: normalized.retryAfterMs ?? null,
          latencyMs: Date.now() - startedAt,
          at: new Date().toISOString(),
        });
        lastError = error;
        if (this.isSafeToRetry(provider, normalized)) continue;
        return { accepted: false, error, attempts };
      }
    }
    if (!lastError) {
      lastError = new SmsProviderError(
        'unavailable', service.provider_slug, 'The SMS provider is temporarily unavailable', true, 503,
      );
    }
    return { accepted: false, error: lastError, attempts };
  }

  /**
   * A provider failure is safe to retry (and therefore safe to fall back from) only when
   * duplicate delivery can be ruled out: temporary unavailability and explicit rate limiting
   * are safe; a timeout is safe only when the provider guarantees idempotent retries with
   * the same stable key. Rejected destinations, invalid requests, bad credentials and
   * unparseable accepted responses are never retried.
   */
  private isSafeToRetry(provider: SmsProvider, normalized: ReturnType<typeof normalizeSmsProviderError>): boolean {
    if (normalized.kind === 'unavailable' || normalized.kind === 'rate_limited') return true;
    if (normalized.kind === 'timeout') return provider.manifest.capabilities.idempotentRetries;
    return false;
  }

  private attempt(providerSlug: string, outcome: SmsProviderAttempt['outcome'], error: unknown): SmsProviderAttempt {
    const normalized = normalizeSmsProviderError(error, providerSlug);
    return {
      provider: providerSlug,
      outcome,
      failureKind: normalized.kind,
      retryAfterMs: normalized.retryAfterMs ?? null,
      latencyMs: null,
      at: new Date().toISOString(),
    };
  }

  private async recordProviderHealth(providerRowId: string, health: { status: string; message: string }): Promise<void> {
    await this.db.query(
      `UPDATE sms_providers SET last_status = $2, last_status_message = $3, last_health_checked_at = now(), updated_at = now()
        WHERE id = $1`,
      [providerRowId, health.status, health.message],
    );
  }

  private async resolveCustomerId(merchantId: string, customerId?: string): Promise<string> {
    if (customerId) {
      const found = await this.db.query(
        'SELECT id FROM customers WHERE id = $1 AND merchant_id = $2', [customerId, merchantId],
      );
      if (!found.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');
      return customerId;
    }
    // Without an explicit customer, SMS usage bills the merchant's own account. The
    // get-or-create customer row is the merchant's own billing identity for this service.
    await this.db.query(
      `INSERT INTO customers (id, merchant_id, external_id, name, metadata)
       VALUES ($1, $2, 'merchant-self', $3, '{"purpose":"merchant_self_billing"}'::jsonb)
       ON CONFLICT (merchant_id, external_id) DO NOTHING`,
      [newId(), merchantId, 'Merchant SMS account'],
    );
    const account = await this.db.query<{ id: string }>(
      `SELECT id FROM customers WHERE merchant_id = $1 AND external_id = 'merchant-self'`, [merchantId],
    );
    const row = account.rows[0];
    if (!row) throw new Error('Could not initialize the merchant SMS billing customer');
    return row.id;
  }

  private async authorize(input: {
    kind: SmsRequestKind;
    merchantId: string;
    requestId: string;
    serviceSlug: string;
    to: string;
    customerId: string;
    metadata: Record<string, unknown>;
    renderMessage: (service: SmsServiceRecord) => string;
  }) {
    return this.db.transaction(async (client) => {
      const service = await this.getEnabledService(client, input.serviceSlug);
      const message = input.renderMessage(service);
      const estimatedUnits = estimateSmsSegments(message);

      const creditsPerUsdcRate = await this.pricing.getCreditSettings(client);
      const worstCase = calculateSmsUsagePrice(smsPricingModel(service), estimatedUnits);
      const authorizedCreditUnits = creditUnitsForPrice(worstCase.customerPriceUsd, creditsPerUsdcRate);
      if (authorizedCreditUnits <= 0n) {
        throw new HttpError(409, 'SMS service pricing must produce a positive customer charge', 'zero_sms_usage_price');
      }

      await client.query(
        `INSERT INTO credit_accounts (id, merchant_id, customer_id) VALUES ($1, $2, $3)
         ON CONFLICT (merchant_id, customer_id) DO NOTHING`,
        [newId(), input.merchantId, input.customerId],
      );
      const account = await client.query<{ id: string; balance_units: string }>(
        `SELECT id, balance_units::text AS balance_units FROM credit_accounts
          WHERE merchant_id = $1 AND customer_id = $2 FOR UPDATE`,
        [input.merchantId, input.customerId],
      );
      const creditAccount = account.rows[0];
      if (!creditAccount) throw new Error('Could not initialize SMS usage credit account');
      if (BigInt(creditAccount.balance_units) < authorizedCreditUnits) {
        throw new HttpError(409, 'Insufficient credits for the maximum cost of this request', 'insufficient_credits');
      }

      const existing = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM sms_provider_requests WHERE merchant_id = $1 AND request_id = $2',
        [input.merchantId, input.requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status === 'AUTHORIZED') {
          throw new HttpError(409, 'A request with this identifier is still being processed', 'sms_request_in_progress');
        }
        throw new HttpError(409, 'This SMS request identifier has already been used', 'sms_request_conflict');
      }

      const providerRequestId = newId();
      await client.query(
        `INSERT INTO sms_provider_requests (id, merchant_id, customer_id, service_id, provider_id, request_id, kind, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'AUTHORIZED')`,
        [providerRequestId, input.merchantId, input.customerId, service.service_id, service.provider_id,
          input.requestId, input.kind],
      );
      return {
        providerRequestId,
        service,
        message,
        estimatedUnits,
        creditAccountId: creditAccount.id,
        creditsPerUsdcRate,
        merchantId: input.merchantId,
        customerId: input.customerId,
        requestId: input.requestId,
        to: input.to,
        kind: input.kind,
        metadata: input.metadata,
      };
    });
  }

  private async getEnabledService(client: PoolClient, serviceSlug: string): Promise<SmsServiceRecord> {
    const result = await client.query<SmsServiceRecord>(
      `SELECT ${serviceFields}
         FROM ${serviceJoin}
        WHERE s.slug = $1 AND s.enabled = true AND p.enabled = true`,
      [serviceSlug],
    );
    const service = result.rows[0];
    if (!service) throw new HttpError(404, 'Enabled SMS service not found', 'sms_service_not_found');
    return service;
  }

  private async settle(authorization: {
    providerRequestId: string;
    service: SmsServiceRecord;
    estimatedUnits: number;
    creditAccountId: string;
    creditsPerUsdcRate: number;
    merchantId: string;
    customerId: string;
    requestId: string;
    to: string;
    kind: SmsRequestKind;
    metadata: Record<string, unknown>;
  }, outcome: {
    units: number;
    usageAuthoritative: boolean;
    providerRequestId: string;
    providerMessageId: string;
    providerCostUsd: string | null;
    latencyMs: number;
    acceptingProvider: { id: string; slug: string };
    attempts: SmsProviderAttempt[];
  }) {
    return this.db.transaction(async (client) => {
      const request = await client.query<{ status: string }>(
        'SELECT status FROM sms_provider_requests WHERE id = $1 FOR UPDATE',
        [authorization.providerRequestId],
      );
      if (request.rows[0]?.status !== 'AUTHORIZED') {
        throw new HttpError(409, 'This SMS request has already been settled', 'sms_request_already_settled');
      }
      // Re-read the service, credit settings and account lock so the settled charge uses
      // current configuration and cannot interleave with a concurrent deduction.
      const service = await this.getEnabledService(client, authorization.service.service_slug);
      if (service.service_id !== authorization.service.service_id) {
        throw new HttpError(409, 'The SMS service is no longer available', 'sms_service_not_found');
      }
      const creditsPerUsdcRate = await this.pricing.getCreditSettings(client);
      await client.query(
        'SELECT id FROM credit_accounts WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [authorization.creditAccountId, authorization.merchantId],
      );

      const price = calculateSmsUsagePrice(smsPricingModel(service), outcome.units);
      const providerCostUsd = outcome.providerCostUsd ?? price.providerCostUsd;
      const profitUsd = usdFromUnits(usdToUnits(price.customerPriceUsd) - usdToUnits(providerCostUsd));
      const creditUnits = creditUnitsForPrice(price.customerPriceUsd, creditsPerUsdcRate);
      if (creditUnits <= 0n) {
        throw new HttpError(409, 'SMS service pricing must produce a positive customer charge', 'zero_sms_usage_price');
      }

      const usageId = newId();
      const reference = `sms:${authorization.requestId}`;
      const transactionMetadata = {
        purpose: 'sms_usage', usageId, requestId: authorization.requestId,
        service: service.service_slug, provider: outcome.acceptingProvider.slug, kind: authorization.kind,
      };
      const settlement = await deductUsageCreditsInTransaction(client, {
        merchantId: authorization.merchantId,
        customerId: authorization.customerId,
        accountId: authorization.creditAccountId,
        creditUnits,
        reference,
        idempotencyKey: reference,
        transactionMetadata,
      });
      await client.query(
        `INSERT INTO sms_usage_records (id, merchant_id, customer_id, credit_account_id, credit_transaction_id,
                                       service_id, provider_id, sms_provider_request_id, request_id, kind, units,
                                       customer_price_usd, provider_cost_usd, profit_usd,
                                       credits_deducted_units, credits_per_usdc_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [usageId, authorization.merchantId, authorization.customerId, authorization.creditAccountId,
          settlement.transactionId, service.service_id, outcome.acceptingProvider.id, authorization.providerRequestId,
          authorization.requestId, authorization.kind, outcome.units, price.customerPriceUsd, providerCostUsd,
          profitUsd, creditUnits.toString(), creditsPerUsdcRate],
      );
      await client.query(
        `UPDATE sms_provider_requests
            SET status = 'COMPLETED', provider_id = $2, provider_request_id = $3, provider_message_id = $4,
                units = $5, usage_authoritative = $6, latency_ms = $7, attempts = $8::jsonb, completed_at = now()
          WHERE id = $1`,
        [authorization.providerRequestId, outcome.acceptingProvider.id, outcome.providerRequestId,
          outcome.providerMessageId, outcome.units, outcome.usageAuthoritative, outcome.latencyMs,
          JSON.stringify(outcome.attempts)],
      );
      await enqueueWebhookEvent({
        client, merchantId: authorization.merchantId, eventType: 'credit.deducted',
        resourceId: settlement.transactionId,
        data: {
          creditTransactionId: settlement.transactionId, creditAccountId: authorization.creditAccountId,
          customerId: authorization.customerId, creditAmount: settlement.creditAmount,
          balanceAfter: formatUnits(settlement.balanceAfter, 6), reference, metadata: transactionMetadata,
        },
      });
      const usageSource = outcome.usageAuthoritative ? 'provider' : 'estimated';
      const fallbackUsed = outcome.attempts.length > 0;
      await enqueueWebhookEvent({
        client, merchantId: authorization.merchantId, eventType: 'sms.request.completed',
        resourceId: authorization.providerRequestId,
        data: {
          requestId: authorization.requestId, kind: authorization.kind,
          service: service.service_slug, provider: outcome.acceptingProvider.slug,
          fallbackUsed, attempts: outcome.attempts.length,
          units: outcome.units, usageSource,
          customerPriceUsd: price.customerPriceUsd, creditsDeducted: settlement.creditAmount,
        },
      });
      return {
        status: 201,
        body: {
          request: {
            id: authorization.providerRequestId,
            requestId: authorization.requestId,
            customerId: authorization.customerId,
            service: service.service_slug,
            provider: outcome.acceptingProvider.slug,
            kind: authorization.kind,
            providerRequestId: outcome.providerRequestId,
            providerMessageId: outcome.providerMessageId,
            status: 'sent' as const,
            latencyMs: outcome.latencyMs,
            fallbackUsed,
          },
          usage: {
            id: usageId,
            requestId: authorization.requestId,
            kind: authorization.kind,
            units: outcome.units,
            usageSource,
            customerPriceUsd: price.customerPriceUsd,
            creditsDeducted: settlement.creditAmount,
            balanceAfter: formatUnits(settlement.balanceAfter, 6),
            currency: 'CREDITS' as const,
          },
        },
      };
    });
  }

  private async failRequest(
    providerRequestId: string,
    error: unknown,
    latencyMs: number,
    options?: { failureKind?: string; failureMessage?: string; attempts?: SmsProviderAttempt[] },
  ): Promise<void> {
    const normalized = normalizeSmsProviderError(error, 'sms');
    const failureKind = options?.failureKind ?? normalized.kind;
    const failureMessage = options?.failureMessage ?? smsProviderErrorMessage(normalized.kind);
    const attempts = options?.attempts ?? [];
    await this.db.transaction(async (client) => {
      const result = await client.query<{ id: string; merchant_id: string; request_id: string }>(
        'SELECT id, merchant_id, request_id FROM sms_provider_requests WHERE id = $1 AND status = $2',
        [providerRequestId, 'AUTHORIZED'],
      );
      const row = result.rows[0];
      if (!row) return;
      await client.query(
        `UPDATE sms_provider_requests SET status = 'FAILED', failure_kind = $2, failure_message = $3,
                latency_ms = $4, attempts = $5::jsonb, completed_at = now()
          WHERE id = $1`,
        [row.id, failureKind, failureMessage, latencyMs, JSON.stringify(attempts)],
      );
      await enqueueWebhookEvent({
        client, merchantId: row.merchant_id, eventType: 'sms.request.failed', resourceId: row.id,
        data: {
          requestId: row.request_id, reason: failureKind, retryable: normalized.retryable,
          ...(attempts.length ? { attempts: attempts.length } : {}),
        },
      });
    });
  }

  private toHttpError(error: unknown): HttpError {
    const normalized = error instanceof SmsProviderError ? error : normalizeSmsProviderError(error, 'sms');
    // Use the canonical message and code so provider-supplied text never reaches the client.
    return new HttpError(normalized.statusCode, smsProviderErrorMessage(normalized.kind), smsProviderErrorCode(normalized.kind));
  }
}
