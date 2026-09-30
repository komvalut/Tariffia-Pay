import { describe, expect, it, vi } from 'vitest';
import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentAdapterConfiguration,
  PaymentAdapterManifest,
  PaymentRequest,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../src/payment-adapter.js';
import { PaymentAdapterError } from '../src/payment-adapters/errors.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';

const manifest: PaymentAdapterManifest = {
  id: 'sample',
  name: 'Sample Rail',
  version: '1.0.0',
  description: 'Test-only payment rail',
  capabilities: {
    paymentRequests: true,
    transactionVerification: true,
    automaticDetection: false,
    refunds: false,
    currencies: ['USDC'],
    networks: ['sample-net'],
  },
  idempotency: {
    paymentCreation: 'stable-key-required',
    transactionVerification: 'network-and-transaction-id',
  },
};

class SampleAdapter implements PaymentAdapter {
  readonly id = manifest.id;
  readonly manifest = manifest;
  readonly createRequest = vi.fn(async (input: PaymentRequest): Promise<AdapterPaymentDetails> => ({
    adapter: this.id,
    network: 'sample-net',
    currency: input.currency,
    recipientAddress: input.recipient,
    tokenAddress: null,
    amountBaseUnits: '250',
    adapterData: { privateReference: 'adapter-only' },
  }));
  verificationResult: PaymentVerificationResult = { state: 'not_found' };
  initialize = vi.fn(async (_settings: Readonly<Record<string, unknown>>) => {});
  shutdown = vi.fn(async () => {});
  health = vi.fn(async () => ({ status: 'healthy' as const, message: 'Ready' }));
  normalizeTransactionId = (transactionId: string) => transactionId;
  verifyTransaction = vi.fn(async (_input: PaymentVerificationInput) => this.verificationResult);
}

function configuration(overrides: Partial<PaymentAdapterConfiguration> = {}): PaymentAdapterConfiguration {
  return { enabled: true, settings: { apiSecret: 'must-not-be-returned' }, isDefault: true, ...overrides };
}

function paymentRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    paymentId: 'payment-1', idempotencyKey: 'stable-server-generated-key', amount: '2.50',
    currency: 'USDC', recipient: 'merchant-account', expiresAt: null, ...overrides,
  };
}

function verificationInput(overrides: Partial<PaymentVerificationInput> = {}): PaymentVerificationInput {
  return {
    paymentId: 'payment-1', transactionId: 'receipt-abc', amount: '2.50', amountBaseUnits: '250',
    currency: 'USDC', network: 'sample-net', recipientAddress: 'merchant-account', tokenAddress: null,
    adapterData: { privateReference: 'adapter-only' }, createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides,
  };
}

describe('PaymentAdapterRegistry', () => {
  it('registers and discovers installed adapters without exposing configuration', async () => {
    const adapter = new SampleAdapter();
    const registry = new PaymentAdapterRegistry();
    registry.register(adapter, configuration());
    await registry.initialize();

    const [discovered] = await registry.list();
    expect(discovered).toMatchObject({
      id: 'sample', name: 'Sample Rail', status: 'enabled', lifecycle: 'ready',
      capabilities: manifest.capabilities, health: { status: 'healthy' },
    });
    expect(JSON.stringify(discovered)).not.toContain('must-not-be-returned');
    expect(() => registry.register(new SampleAdapter(), configuration({ isDefault: false })))
      .toThrow('already initialized');
  });

  it('rejects duplicate registrations and invalid adapter configuration', async () => {
    const registry = new PaymentAdapterRegistry();
    const adapter = new SampleAdapter();
    registry.register(adapter, configuration());
    expect(() => registry.register(new SampleAdapter(), configuration({ isDefault: false })))
      .toThrow('already registered');
    adapter.initialize.mockImplementationOnce(async () => { throw new Error('secret-bearing invalid settings'); });
    await expect(registry.initialize()).rejects.toMatchObject({
      code: 'invalid_configuration', message: 'Payment adapter configuration is invalid',
    });
  });

  it('selects the configured default or explicit adapter and blocks disabled methods only for new payments', async () => {
    const enabled = new SampleAdapter();
    const disabled = new SampleAdapter();
    Object.defineProperty(disabled, 'id', { value: 'disabled-rail' });
    Object.defineProperty(disabled, 'manifest', { value: { ...manifest, id: 'disabled-rail' } });
    const registry = new PaymentAdapterRegistry();
    registry.register(enabled, configuration());
    registry.register(disabled, configuration({ enabled: false, isDefault: false, settings: {} }));
    await registry.initialize();

    expect(registry.getDefaultForNewPayments()).toBe(enabled);
    expect(registry.getForNewPayments('sample')).toBe(enabled);
    expect(registry.normalizeTransactionId('sample', 'Case-Sensitive-Id')).toBe('Case-Sensitive-Id');
    expect(() => registry.getForNewPayments('disabled-rail')).toThrow('disabled');
    expect(registry.getForVerification('disabled-rail')).toBe(disabled);
    expect(() => registry.getForNewPayments('missing')).toThrow('not installed');
    const listed = await registry.list();
    expect(listed.find((entry) => entry.id === 'disabled-rail')?.status).toBe('disabled');
  });

  it('passes a stable idempotency key into adapter requests and normalizes thrown adapter errors', async () => {
    const adapter = new SampleAdapter();
    const registry = new PaymentAdapterRegistry();
    registry.register(adapter, configuration());
    await registry.initialize();
    const request = paymentRequest();

    await registry.createRequest(adapter.id, request);
    expect(adapter.createRequest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: request.idempotencyKey }));

    adapter.createRequest.mockRejectedValueOnce(new Error('provider secret=do-not-leak'));
    await expect(registry.createRequest(adapter.id, request)).rejects.toMatchObject({
      code: 'unavailable', operation: 'create_request', retryable: true,
      message: 'Payment adapter is temporarily unavailable',
    } satisfies Partial<PaymentAdapterError>);
  });

  it('uses and validates the normalized transaction receipt contract', async () => {
    const adapter = new SampleAdapter();
    const registry = new PaymentAdapterRegistry();
    registry.register(adapter, configuration());
    await registry.initialize();
    const input = verificationInput();
    const receipt = {
      transactionId: input.transactionId, network: input.network, state: 'confirmed' as const,
      amount: input.amount, currency: input.currency, recipient: input.recipientAddress,
      confirmations: 4, blockNumber: '1234',
    };
    adapter.verificationResult = { state: 'verified', receipt };
    await expect(registry.verifyTransaction(adapter.id, input)).resolves.toEqual({ state: 'verified', receipt });

    adapter.verificationResult = { state: 'verified', receipt: { ...receipt, transactionId: 'another-receipt' } };
    await expect(registry.verifyTransaction(adapter.id, input)).rejects.toMatchObject({ code: 'invalid_response' });
    adapter.verifyTransaction.mockRejectedValueOnce(new Error('provider token=must-not-escape'));
    await expect(registry.verifyTransaction(adapter.id, input)).rejects.toMatchObject({
      code: 'unavailable', message: 'Payment adapter is temporarily unavailable',
    });
  });

  it('runs adapter shutdown lifecycle', async () => {
    const adapter = new SampleAdapter();
    const registry = new PaymentAdapterRegistry();
    registry.register(adapter, configuration());
    await registry.initialize();
    await registry.shutdown();
    expect(adapter.shutdown).toHaveBeenCalledOnce();
    expect((await registry.list())[0]?.lifecycle).toBe('stopped');
  });
});
