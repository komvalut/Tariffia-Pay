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
  s.customer_price_per_sms_usd::text AS customer_price_per_sms_usd,
  s.provider_cost_per_sms_usd::text AS provider_cost_per_sms_usd, s.markup_bps,
  s.otp_length, s.otp_expiry_seconds, s.otp_message_template, s.max_message_length`;

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
         FROM sms_services s JOIN sms_providers p ON p.id = s.provider_id
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
    let provider: SmsProvider;
    try {
      provider = this.providers.getConfiguredProvider(authorization.service.provider_slug);
    } catch (error) {
      await this.failRequest(authorization.providerRequestId, error, 0);
      throw this.toHttpError(error);
    }

    const startedAt = Date.now();
    let delivery: SmsDeliveryResult;
    try {
      delivery = input.kind === 'OTP' && provider.manifest.capabilities.sendOtp && provider.sendOtp
        ? await provider.sendOtp({
          requestId: input.requestId,
          to: input.to,
          codeLength: authorization.service.otp_length,
          expirySeconds: authorization.service.otp_expiry_seconds,
        })
        : await provider.sendSms({ requestId: input.requestId, to: input.to, message: authorization.message });
    } catch (error) {
      await this.failRequest(authorization.providerRequestId, error, Date.now() - startedAt);
      throw this.toHttpError(error);
    }

    const units = delivery.segmentsAuthoritative ? delivery.segments : authorization.estimatedUnits;
    const settled = await this.settle(authorization, {
      units,
      usageAuthoritative: delivery.segmentsAuthoritative,
      providerRequestId: delivery.providerRequestId,
      providerMessageId: delivery.providerMessageId,
      providerCostUsd: delivery.providerCostUsd,
      latencyMs: Date.now() - startedAt,
    });
    return settled;
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
         FROM sms_services s JOIN sms_providers p ON p.id = s.provider_id
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
        service: service.service_slug, provider: service.provider_slug, kind: authorization.kind,
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
          settlement.transactionId, service.service_id, service.provider_id, authorization.providerRequestId,
          authorization.requestId, authorization.kind, outcome.units, price.customerPriceUsd, providerCostUsd,
          profitUsd, creditUnits.toString(), creditsPerUsdcRate],
      );
      await client.query(
        `UPDATE sms_provider_requests
            SET status = 'COMPLETED', provider_request_id = $2, provider_message_id = $3,
                units = $4, usage_authoritative = $5, latency_ms = $6, completed_at = now()
          WHERE id = $1`,
        [authorization.providerRequestId, outcome.providerRequestId, outcome.providerMessageId,
          outcome.units, outcome.usageAuthoritative, outcome.latencyMs],
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
      await enqueueWebhookEvent({
        client, merchantId: authorization.merchantId, eventType: 'sms.request.completed',
        resourceId: authorization.providerRequestId,
        data: {
          requestId: authorization.requestId, kind: authorization.kind,
          service: service.service_slug, provider: service.provider_slug,
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
            provider: service.provider_slug,
            kind: authorization.kind,
            providerRequestId: outcome.providerRequestId,
            providerMessageId: outcome.providerMessageId,
            status: 'sent' as const,
            latencyMs: outcome.latencyMs,
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

  private async failRequest(providerRequestId: string, error: unknown, latencyMs: number): Promise<void> {
    const normalized = normalizeSmsProviderError(error, 'sms');
    await this.db.transaction(async (client) => {
      const result = await client.query<{ id: string; merchant_id: string; request_id: string }>(
        'SELECT id, merchant_id, request_id FROM sms_provider_requests WHERE id = $1 AND status = $2',
        [providerRequestId, 'AUTHORIZED'],
      );
      const row = result.rows[0];
      if (!row) return;
      await client.query(
        `UPDATE sms_provider_requests SET status = 'FAILED', failure_kind = $2, failure_message = $3,
                latency_ms = $4, completed_at = now()
          WHERE id = $1`,
        [row.id, normalized.kind, smsProviderErrorMessage(normalized.kind), latencyMs],
      );
      await enqueueWebhookEvent({
        client, merchantId: row.merchant_id, eventType: 'sms.request.failed', resourceId: row.id,
        data: { requestId: row.request_id, reason: normalized.kind, retryable: normalized.retryable },
      });
    });
  }

  private toHttpError(error: unknown): HttpError {
    const normalized = error instanceof SmsProviderError ? error : normalizeSmsProviderError(error, 'sms');
    // Use the canonical message and code so provider-supplied text never reaches the client.
    return new HttpError(normalized.statusCode, smsProviderErrorMessage(normalized.kind), smsProviderErrorCode(normalized.kind));
  }
}
