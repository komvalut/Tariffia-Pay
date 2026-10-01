import { formatUnits } from 'viem';
import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { runIdempotently } from '../idempotency.js';
import { newId } from '../security.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';

const USD_SCALE = 100_000_000n;

export type AiPricingMode = 'PER_REQUEST' | 'PER_1K_TOKENS' | 'PER_REQUEST_AND_TOKENS';

export type AiPricingModel = {
  pricing_mode: AiPricingMode;
  provider_cost_per_request_usd: string;
  customer_price_per_request_usd: string | null;
  provider_input_cost_per_1k_usd: string;
  customer_input_price_per_1k_usd: string | null;
  provider_output_cost_per_1k_usd: string;
  customer_output_price_per_1k_usd: string | null;
  markup_bps: number;
};

export function usdToUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * USD_SCALE + BigInt(fraction.padEnd(8, '0'));
}

export function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function usdFromUnits(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / USD_SCALE;
  const fraction = (absolute % USD_SCALE).toString().padStart(8, '0');
  return `${sign}${whole}.${fraction}`;
}

function markedUpRate(providerRate: bigint, markupBps: number): bigint {
  return ceilDiv(providerRate * BigInt(10_000 + markupBps), 10_000n);
}

function perThousand(rate: bigint, tokens: number): bigint {
  return ceilDiv(rate * BigInt(tokens), 1_000n);
}

export function customerAiPricesPerUnit(model: AiPricingModel) {
  const hasRequest = model.pricing_mode !== 'PER_1K_TOKENS';
  const hasTokens = model.pricing_mode !== 'PER_REQUEST';
  const providerRequest = hasRequest ? usdToUnits(model.provider_cost_per_request_usd) : 0n;
  const customerRequest = hasRequest
    ? model.customer_price_per_request_usd === null
      ? markedUpRate(providerRequest, model.markup_bps)
      : usdToUnits(model.customer_price_per_request_usd)
    : 0n;
  const providerInputRate = hasTokens ? usdToUnits(model.provider_input_cost_per_1k_usd) : 0n;
  const providerOutputRate = hasTokens ? usdToUnits(model.provider_output_cost_per_1k_usd) : 0n;
  const customerInputRate = hasTokens
    ? model.customer_input_price_per_1k_usd === null
      ? markedUpRate(providerInputRate, model.markup_bps)
      : usdToUnits(model.customer_input_price_per_1k_usd)
    : 0n;
  const customerOutputRate = hasTokens
    ? model.customer_output_price_per_1k_usd === null
      ? markedUpRate(providerOutputRate, model.markup_bps)
      : usdToUnits(model.customer_output_price_per_1k_usd)
    : 0n;
  return {
    requestUsd: usdFromUnits(customerRequest),
    inputPer1kUsd: usdFromUnits(customerInputRate),
    outputPer1kUsd: usdFromUnits(customerOutputRate),
    requestUnits: customerRequest,
    inputPer1kUnits: customerInputRate,
    outputPer1kUnits: customerOutputRate,
  };
}

export function calculateAiUsagePrice(model: AiPricingModel, inputTokens: number, outputTokens: number) {
  const hasRequest = model.pricing_mode !== 'PER_1K_TOKENS';
  const hasTokens = model.pricing_mode !== 'PER_REQUEST';
  const providerRequest = hasRequest ? usdToUnits(model.provider_cost_per_request_usd) : 0n;
  const providerInputRate = hasTokens ? usdToUnits(model.provider_input_cost_per_1k_usd) : 0n;
  const providerOutputRate = hasTokens ? usdToUnits(model.provider_output_cost_per_1k_usd) : 0n;
  const rates = customerAiPricesPerUnit(model);
  const providerCost = providerRequest + perThousand(providerInputRate, inputTokens) + perThousand(providerOutputRate, outputTokens);
  const customerPrice = rates.requestUnits + perThousand(rates.inputPer1kUnits, inputTokens) + perThousand(rates.outputPer1kUnits, outputTokens);
  return {
    providerCostUsd: usdFromUnits(providerCost),
    customerPriceUsd: usdFromUnits(customerPrice),
    profitUsd: usdFromUnits(customerPrice - providerCost),
  };
}

export type AiPricedModel = AiPricingModel & {
  provider_id: string;
  provider_slug: string;
  model_id: string;
  model_slug: string;
  model_name: string;
  provider_model: string | null;
  max_output_tokens: number;
};

/** Column list shared by every model lookup so pricing stays in one place. */
const pricedModelFields = `p.id AS provider_id, p.slug AS provider_slug, m.id AS model_id, m.slug AS model_slug,
  m.name AS model_name, m.provider_model, m.max_output_tokens, m.pricing_mode,
  m.provider_cost_per_request_usd::text AS provider_cost_per_request_usd,
  m.customer_price_per_request_usd::text AS customer_price_per_request_usd,
  m.provider_input_cost_per_1k_usd::text AS provider_input_cost_per_1k_usd,
  m.customer_input_price_per_1k_usd::text AS customer_input_price_per_1k_usd,
  m.provider_output_cost_per_1k_usd::text AS provider_output_cost_per_1k_usd,
  m.customer_output_price_per_1k_usd::text AS customer_output_price_per_1k_usd, m.markup_bps`;

/** Converts a customer price into credit units using the configured rate, rounding upward. */
export function creditUnitsForPrice(customerPriceUsd: string, creditsPerUsdcRate: number): bigint {
  return ceilDiv(usdToUnits(customerPriceUsd) * BigInt(creditsPerUsdcRate), 100n);
}

export class AiPricingEngine {
  constructor(private readonly db: Database) {}

  /**
   * Resolves an enabled provider/model with its pricing configuration. The caller must hold a
   * row lock that covers the model when it must stay stable for the rest of the transaction.
   */
  async getPricedModel(client: PoolClient, provider: string, model: string): Promise<AiPricedModel | undefined> {
    const result = await client.query<AiPricedModel>(
      `SELECT ${pricedModelFields}
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
        WHERE p.slug = $1 AND m.slug = $2 AND p.enabled = true AND m.enabled = true`,
      [provider, model],
    );
    return result.rows[0];
  }

  async getCreditSettings(client: PoolClient): Promise<number> {
    const settings = await client.query<{ credits_per_usdc_rate: number }>(
      'SELECT credits_per_usdc_rate FROM credit_settings WHERE id = 1',
    );
    const creditsPerUsdcRate = settings.rows[0]?.credits_per_usdc_rate;
    if (!creditsPerUsdcRate) throw new Error('Credit settings have not been initialized');
    return creditsPerUsdcRate;
  }

  /**
   * Atomically deducts credits, writes the ledger entry and stores the usage record.
   * The caller must already hold the credit account row lock inside its own transaction.
   */
  async settleUsageInTransaction(client: PoolClient, input: {
    merchantId: string;
    customerId: string;
    accountId: string;
    requestId: string;
    model: AiPricedModel;
    inputTokens: number;
    outputTokens: number;
    creditsPerUsdcRate: number;
    metadata: Record<string, unknown>;
    providerRequestId?: string | null;
    usageAuthoritative?: boolean;
  }) {
    const price = calculateAiUsagePrice(input.model, input.inputTokens, input.outputTokens);
    const creditUnits = creditUnitsForPrice(price.customerPriceUsd, input.creditsPerUsdcRate);
    if (creditUnits <= 0n) throw new HttpError(409, 'AI model pricing must produce a positive customer charge', 'zero_ai_usage_price');

    const balanceResult = await client.query<{ balance_units: string }>(
      `UPDATE credit_accounts SET balance_units = balance_units - $2, updated_at = now()
        WHERE id = $1 AND balance_units >= $2 RETURNING balance_units::text AS balance_units`,
      [input.accountId, creditUnits.toString()],
    );
    if (!balanceResult.rows[0]) throw new HttpError(409, 'Insufficient credits', 'insufficient_credits');

    const transactionId = newId();
    const usageId = newId();
    const balanceAfter = BigInt(balanceResult.rows[0].balance_units);
    const reference = `ai:${input.requestId}`;
    const transactionMetadata = {
      purpose: 'ai_usage', usageId, requestId: input.requestId,
      provider: input.model.provider_slug, model: input.model.model_slug,
    };
    await client.query(
      `INSERT INTO credit_transactions (id, merchant_id, account_id, customer_id, transaction_type,
                                       credit_units, balance_after_units, reference, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, 'DEDUCTION', $5, $6, $7, $8, $9::jsonb)`,
      [transactionId, input.merchantId, input.accountId, input.customerId, creditUnits.toString(),
        balanceAfter.toString(), reference, `ai:${input.requestId}`, JSON.stringify(transactionMetadata)],
    );
    await client.query(
      `INSERT INTO ledger_entries (id, merchant_id, entry_type, amount, currency, reference, metadata)
       VALUES ($1, $2, 'CREDIT_DEDUCTION', $3, 'CREDITS', $4, $5::jsonb)`,
      [newId(), input.merchantId, formatUnits(creditUnits, 6), transactionId,
        JSON.stringify({ customerId: input.customerId, creditTransactionId: transactionId, ...transactionMetadata })],
    );
    await client.query(
      `INSERT INTO ai_usage_records (id, merchant_id, customer_id, credit_account_id, credit_transaction_id,
                                    provider_id, model_id, request_id, pricing_mode, input_tokens, output_tokens,
                                    total_tokens, provider_cost_usd, customer_price_usd, profit_usd,
                                    credits_deducted_units, credits_per_usdc_rate, metadata, provider_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)`,
      [usageId, input.merchantId, input.customerId, input.accountId, transactionId, input.model.provider_id,
        input.model.model_id, input.requestId, input.model.pricing_mode, input.inputTokens, input.outputTokens,
        input.inputTokens + input.outputTokens, price.providerCostUsd, price.customerPriceUsd, price.profitUsd,
        creditUnits.toString(), input.creditsPerUsdcRate, JSON.stringify(input.metadata), input.providerRequestId ?? null],
    );

    const eventData = {
      usageId, requestId: input.requestId, customerId: input.customerId,
      provider: input.model.provider_slug, model: input.model.model_slug, pricingMode: input.model.pricing_mode,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      customerPriceUsd: price.customerPriceUsd, creditsDeducted: formatUnits(creditUnits, 6),
      balanceAfter: formatUnits(balanceAfter, 6), metadata: input.metadata,
    };
    await enqueueWebhookEvent({
      client, merchantId: input.merchantId, eventType: 'credit.deducted', resourceId: transactionId,
      data: { creditTransactionId: transactionId, creditAccountId: input.accountId, customerId: input.customerId,
        creditAmount: formatUnits(creditUnits, 6), balanceAfter: formatUnits(balanceAfter, 6), reference,
        metadata: transactionMetadata },
    });
    await enqueueWebhookEvent({
      client, merchantId: input.merchantId, eventType: 'ai.usage.recorded', resourceId: usageId, data: eventData,
    });
    return {
      price,
      usage: {
        id: usageId, requestId: input.requestId, customerId: input.customerId,
        provider: input.model.provider_slug, model: input.model.model_slug, pricingMode: input.model.pricing_mode,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        customerPriceUsd: price.customerPriceUsd, creditsDeducted: formatUnits(creditUnits, 6),
        balanceAfter: formatUnits(balanceAfter, 6), currency: 'CREDITS', metadata: input.metadata,
      },
    };
  }

  async recordUsage(input: {
    merchantId: string;
    requestId: string;
    customerId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    metadata: Record<string, unknown>;
  }) {
    return runIdempotently({
      db: this.db,
      scope: `merchant:${input.merchantId}:POST:/v1/ai/usage`,
      key: input.requestId,
      request: {
        customerId: input.customerId,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        metadata: input.metadata,
      },
      work: async (client) => this.recordInTransaction(client, input),
    });
  }

  private async recordInTransaction(client: PoolClient, input: {
    merchantId: string;
    requestId: string;
    customerId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    metadata: Record<string, unknown>;
  }) {
    const customer = await client.query('SELECT id FROM customers WHERE id = $1 AND merchant_id = $2', [input.customerId, input.merchantId]);
    if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');

    const model = await this.getPricedModel(client, input.provider, input.model);
    if (!model) throw new HttpError(404, 'Enabled AI model not found', 'ai_model_not_found');
    const creditsPerUsdcRate = await this.getCreditSettings(client);

    await client.query(
      `INSERT INTO credit_accounts (id, merchant_id, customer_id) VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id, customer_id) DO NOTHING`,
      [newId(), input.merchantId, input.customerId],
    );
    const accountResult = await client.query<{ id: string }>(
      'SELECT id FROM credit_accounts WHERE merchant_id = $1 AND customer_id = $2 FOR UPDATE',
      [input.merchantId, input.customerId],
    );
    const account = accountResult.rows[0];
    if (!account) throw new Error('Could not initialize AI usage credit account');

    const settled = await this.settleUsageInTransaction(client, {
      merchantId: input.merchantId,
      customerId: input.customerId,
      accountId: account.id,
      requestId: input.requestId,
      model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      creditsPerUsdcRate,
      metadata: input.metadata,
    });
    return { status: 201, body: { usage: settled.usage } };
  }
}
