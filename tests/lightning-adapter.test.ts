import { describe, expect, it } from 'vitest';
import { BaseUsdcAdapter } from '../src/adapters/usdc/base-usdc-adapter.js';
import { LightningAdapter } from '../src/adapters/lightning-adapter.js';
import type { LightningAdapterSettings } from '../src/adapters/lightning-adapter.js';
import { createDefaultPaymentAdapterRegistry } from '../src/payment-adapters/default-registry.js';
import type { PaymentRequest, PaymentVerificationInput } from '../src/payment-adapter.js';
import { PaymentAdapterError } from '../src/payment-adapters/errors.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import { MockLightningProvider } from './fixtures/mock-lightning-provider.js';

const settings: LightningAdapterSettings = {
  network: 'mainnet', minimumAmountSats: 2, maximumAmountSats: 50_000,
  invoiceExpirySeconds: 3600,
};

function paymentRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    paymentId: 'payment-lightning-1', idempotencyKey: 'merchant-order-key-hash', amount: '25',
    currency: 'SAT', recipient: 'merchant-wallet-is-not-a-lightning-secret',
    description: 'Lightning test invoice', expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    ...overrides,
  };
}

async function lightningRegistry(provider: MockLightningProvider, enabled = true) {
  const adapter = new LightningAdapter(provider);
  const registry = new PaymentAdapterRegistry();
  registry.register(adapter, { enabled, settings, isDefault: enabled });
  await registry.initialize();
  return { adapter, registry };
}

describe('Lightning payment adapter foundation', () => {
  it('registers as a disabled-by-default Lightning method with declared capabilities', async () => {
    const provider = new MockLightningProvider();
    const adapter = new LightningAdapter(provider);
    const registry = new PaymentAdapterRegistry();
    registry.register(adapter, { enabled: false, settings });
    await registry.initialize();

    const summary = (await registry.list()).find((entry) => entry.id === 'lightning');
    expect(summary).toMatchObject({
      name: 'Bitcoin Lightning', isDefault: false, status: 'disabled', lifecycle: 'ready',
      capabilities: {
        paymentRequests: true, transactionVerification: true, automaticDetection: false,
        refunds: false, currencies: ['SAT'],
      },
    });
    expect(summary?.capabilities.networks).toEqual([
      'lightning-mainnet', 'lightning-testnet', 'lightning-signet',
    ]);
    expect(summary?.health.status).toBe('healthy');
    provider.available = false;
    expect((await registry.list()).find((entry) => entry.id === 'lightning')?.health.status).toBe('unavailable');
  });

  it('installs Lightning in the shared registry without replacing the Base USDC default', async () => {
    const registry = createDefaultPaymentAdapterRegistry();
    await registry.initialize();
    expect(registry.getDefaultForNewPayments().id).toBe('usdc');
    expect(registry.getForVerification('lightning').id).toBe('lightning');
    await registry.shutdown();
  });

  it('rejects new invoices while disabled and creates a BOLT11-style request when enabled', async () => {
    const disabledProvider = new MockLightningProvider();
    const disabled = await lightningRegistry(disabledProvider, false);
    await expect(disabled.registry.createRequest('lightning', paymentRequest())).rejects.toMatchObject({
      code: 'unavailable', message: 'The selected payment method is disabled',
    });
    expect(disabledProvider.createCalls).toHaveLength(0);

    const provider = new MockLightningProvider();
    const { registry } = await lightningRegistry(provider);
    const details = await registry.createRequest('lightning', paymentRequest());
    expect(details).toMatchObject({
      adapter: 'lightning', network: 'lightning-mainnet', currency: 'SAT',
      recipientAddress: expect.stringMatching(/^lnmock_mainnet_[0-9a-f]{64}$/),
      tokenAddress: null, amountBaseUnits: '25000',
    });
    expect(details.adapterData).toMatchObject({
      paymentHash: expect.stringMatching(/^[0-9a-f]{64}$/), providerReference: expect.any(String),
    });
    expect(provider.createCalls[0]).toMatchObject({
      idempotencyKey: 'merchant-order-key-hash', amountMsat: '25000', memo: 'Lightning test invoice',
    });
    expect(JSON.stringify(details)).not.toContain('privateKey');
  });

  it('validates whole-satoshi amounts and configured invoice bounds', async () => {
    const provider = new MockLightningProvider();
    const { adapter } = await lightningRegistry(provider);
    await expect(adapter.createRequest(paymentRequest({ amount: '1' }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.createRequest(paymentRequest({ amount: '1.5' }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.createRequest(paymentRequest({ amount: '50001' }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.createRequest(paymentRequest({ currency: 'USDC' }))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(provider.createCalls).toHaveLength(0);

    const invalid = new LightningAdapter(provider);
    await expect(invalid.initialize({ ...settings, minimumAmountSats: 100, maximumAmountSats: 99 }))
      .rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it('normalizes invoice payment status and confirms only the matching settled amount', async () => {
    const provider = new MockLightningProvider();
    const { registry } = await lightningRegistry(provider);
    const details = await registry.createRequest('lightning', paymentRequest());
    const paymentHash = String(details.adapterData.paymentHash);
    const input: PaymentVerificationInput = {
      paymentId: 'payment-lightning-1', transactionId: paymentHash.toUpperCase(), amount: '25',
      amountBaseUnits: '25000', currency: 'SAT', network: 'lightning-mainnet',
      recipientAddress: details.recipientAddress, tokenAddress: null, adapterData: details.adapterData,
      createdAt: new Date(),
    };

    expect(registry.normalizeTransactionId('lightning', input.transactionId)).toBe(paymentHash);
    const normalizedInput = { ...input, transactionId: paymentHash };
    await expect(registry.verifyTransaction('lightning', normalizedInput)).resolves.toMatchObject({
      state: 'pending', detected: false, receipt: { transactionId: paymentHash, confirmations: 0, blockNumber: null },
    });

    provider.setState(paymentHash, 'settled');
    await expect(registry.verifyTransaction('lightning', normalizedInput)).resolves.toMatchObject({
      state: 'verified', receipt: {
        transactionId: paymentHash, network: 'lightning-mainnet', state: 'confirmed', amount: '25',
        currency: 'SAT', recipient: details.recipientAddress, confirmations: 1, blockNumber: null,
      },
    });

    await expect(registry.verifyTransaction('lightning', { ...normalizedInput, transactionId: 'f'.repeat(64) }))
      .resolves.toMatchObject({ state: 'rejected' });
    provider.setState(paymentHash, 'expired');
    await expect(registry.verifyTransaction('lightning', normalizedInput))
      .resolves.toMatchObject({ state: 'rejected' });
  });

  it('normalizes provider failures without exposing provider error details', async () => {
    const provider = new MockLightningProvider();
    const { registry } = await lightningRegistry(provider);
    provider.createFailure = new Error('provider credential=secret-value');
    await expect(registry.createRequest('lightning', paymentRequest())).rejects.toMatchObject({
      code: 'unavailable', operation: 'create_request', message: 'Payment adapter is temporarily unavailable',
    } satisfies Partial<PaymentAdapterError>);

    provider.createFailure = undefined;
    const details = await registry.createRequest('lightning', paymentRequest());
    provider.lookupFailure = new Error('node macaroon=secret-value');
    await expect(registry.verifyTransaction('lightning', {
      paymentId: 'payment-lightning-1', transactionId: String(details.adapterData.paymentHash),
      amount: '25', amountBaseUnits: '25000', currency: 'SAT', network: 'lightning-mainnet',
      recipientAddress: details.recipientAddress, tokenAddress: null, adapterData: details.adapterData, createdAt: new Date(),
    })).rejects.toMatchObject({ code: 'unavailable', message: 'Payment adapter is temporarily unavailable' });
    expect((await registry.list()).find((entry) => entry.id === 'lightning')?.health.status).toBe('healthy');
  });

  it('passes stable idempotency keys to the provider and reuses the same invoice', async () => {
    const provider = new MockLightningProvider();
    const { adapter } = await lightningRegistry(provider);
    const first = await adapter.createRequest(paymentRequest());
    const retry = await adapter.createRequest(paymentRequest());
    expect(retry.recipientAddress).toBe(first.recipientAddress);
    expect(provider.createCalls).toHaveLength(2);
    expect(provider.invoicesCreated.size).toBe(1);
    expect(provider.createCalls.every((call) => call.idempotencyKey === 'merchant-order-key-hash')).toBe(true);
  });

  it('keeps the existing Base USDC adapter as the default', async () => {
    const usdc = new BaseUsdcAdapter();
    const registry = new PaymentAdapterRegistry();
    registry.register(usdc, {
      enabled: true,
      settings: {
        rpcUrl: 'https://rpc.example',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32d4F71b54bdA02913',
        minimumConfirmations: 12,
      },
      isDefault: true,
    });
    await registry.initialize();
    expect(registry.getDefaultForNewPayments()).toBe(usdc);
    expect(usdc.manifest).toMatchObject({ id: 'usdc', capabilities: { currencies: ['USDC'], networks: ['base'] } });
    await registry.shutdown();
  });
});
