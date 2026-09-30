import { describe, expect, it } from 'vitest';
import { calculateAiUsagePrice, customerAiPricesPerUnit, type AiPricingModel } from '../src/services/ai-pricing-engine.js';

const baseModel: AiPricingModel = {
  pricing_mode: 'PER_1K_TOKENS',
  provider_cost_per_request_usd: '0.00000000',
  customer_price_per_request_usd: null,
  provider_input_cost_per_1k_usd: '0.01000000',
  customer_input_price_per_1k_usd: null,
  provider_output_cost_per_1k_usd: '0.02000000',
  customer_output_price_per_1k_usd: null,
  markup_bps: 1000,
};

describe('AI usage pricing', () => {
  it('applies markup to input/output token rates using exact fixed-point arithmetic', () => {
    expect(calculateAiUsagePrice(baseModel, 1000, 500)).toEqual({
      providerCostUsd: '0.02000000',
      customerPriceUsd: '0.02200000',
      profitUsd: '0.00200000',
    });
  });

  it('rounds fractional token charges upward and respects explicit customer rates', () => {
    const model = {
      ...baseModel,
      customer_input_price_per_1k_usd: '0.01500000',
      markup_bps: 0,
    };
    expect(calculateAiUsagePrice(model, 1, 0)).toEqual({
      providerCostUsd: '0.00001000',
      customerPriceUsd: '0.00001500',
      profitUsd: '0.00000500',
    });
  });

  it('charges a request price only in request-based modes', () => {
    const model = {
      ...baseModel,
      pricing_mode: 'PER_REQUEST' as const,
      provider_cost_per_request_usd: '0.12500000',
      customer_price_per_request_usd: null,
      markup_bps: 2000,
    };
    expect(calculateAiUsagePrice(model, 10_000, 10_000)).toEqual({
      providerCostUsd: '0.12500000',
      customerPriceUsd: '0.15000000',
      profitUsd: '0.02500000',
    });
  });

  it('keeps request and token component prices distinct for combined pricing', () => {
    const model = {
      ...baseModel,
      pricing_mode: 'PER_REQUEST_AND_TOKENS' as const,
      provider_cost_per_request_usd: '0.10000000',
      customer_price_per_request_usd: '0.13000000',
      provider_input_cost_per_1k_usd: '0.02000000',
      customer_input_price_per_1k_usd: '0.03000000',
      provider_output_cost_per_1k_usd: '0.04000000',
      customer_output_price_per_1k_usd: null,
    };
    expect(customerAiPricesPerUnit(model)).toMatchObject({
      requestUsd: '0.13000000', inputPer1kUsd: '0.03000000', outputPer1kUsd: '0.04400000',
    });
    expect(calculateAiUsagePrice(model, 1000, 1000)).toEqual({
      providerCostUsd: '0.16000000', customerPriceUsd: '0.20400000', profitUsd: '0.04400000',
    });
  });
});
