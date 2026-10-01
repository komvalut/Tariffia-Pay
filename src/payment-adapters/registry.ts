import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentAdapterConfiguration,
  PaymentAdapterHealth,
  PaymentAdapterManifest,
  PaymentRequest,
  PaymentStatusPollResult,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../payment-adapter.js';
import { PaymentAdapterError, normalizeAdapterError } from './errors.js';

type AdapterEntry = {
  adapter: PaymentAdapter;
  configuration: PaymentAdapterConfiguration;
  lifecycle: 'registered' | 'ready' | 'failed' | 'stopped';
};

export type PaymentAdapterSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  isDefault: boolean;
  status: 'enabled' | 'disabled';
  lifecycle: AdapterEntry['lifecycle'];
  capabilities: PaymentAdapterManifest['capabilities'];
  idempotency: PaymentAdapterManifest['idempotency'];
  health: PaymentAdapterHealth;
};

export class PaymentAdapterRegistry {
  private readonly entries = new Map<string, AdapterEntry>();
  private defaultAdapterId?: string;
  private initialized = false;

  register(adapter: PaymentAdapter, configuration: PaymentAdapterConfiguration): void {
    if (this.initialized) throw new Error('Payment adapter registry is already initialized');
    this.validateRegistration(adapter, configuration);
    if (this.entries.has(adapter.id)) throw new Error(`Payment adapter '${adapter.id}' is already registered`);
    if (configuration.isDefault) {
      if (this.defaultAdapterId) throw new Error('Only one default payment adapter may be registered');
      this.defaultAdapterId = adapter.id;
    }
    this.entries.set(adapter.id, { adapter, configuration, lifecycle: 'registered' });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const entry of this.entries.values()) {
      try {
        await entry.adapter.initialize(entry.configuration.settings);
        entry.lifecycle = 'ready';
      } catch (error) {
        entry.lifecycle = 'failed';
        throw normalizeAdapterError(error, 'initialize');
      }
    }
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    for (const entry of [...this.entries.values()].reverse()) {
      if (entry.lifecycle !== 'ready') continue;
      await entry.adapter.shutdown();
      entry.lifecycle = 'stopped';
    }
    this.initialized = false;
  }

  getDefaultForNewPayments(): PaymentAdapter {
    if (!this.defaultAdapterId) throw new PaymentAdapterError('unavailable', 'create_request', 'No default payment adapter is configured');
    return this.getForNewPayments(this.defaultAdapterId);
  }

  getForNewPayments(id: string): PaymentAdapter {
    const entry = this.getEntry(id);
    if (!entry.configuration.enabled) {
      throw new PaymentAdapterError('unavailable', 'create_request', 'The selected payment method is disabled');
    }
    if (entry.lifecycle !== 'ready') {
      throw new PaymentAdapterError('unavailable', 'create_request', 'The selected payment method is not ready', true);
    }
    return entry.adapter;
  }

  getForVerification(id: string): PaymentAdapter {
    const entry = this.getEntry(id);
    if (entry.lifecycle !== 'ready') {
      throw new PaymentAdapterError('unavailable', 'verify_transaction', 'The payment adapter is not available', true);
    }
    return entry.adapter;
  }

  getManifest(id: string): PaymentAdapterManifest | undefined {
    return this.entries.get(id)?.adapter.manifest;
  }

  isEnabled(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.configuration.enabled === true && entry.lifecycle === 'ready';
  }

  normalizeTransactionId(id: string, transactionId: string): string {
    const adapter = this.getForVerification(id);
    try {
      const normalized = adapter.normalizeTransactionId(transactionId);
      if (!normalized || normalized.length > 512) {
        throw new PaymentAdapterError('invalid_request', 'verify_transaction', 'Adapter returned an invalid transaction ID');
      }
      return normalized;
    } catch (error) {
      throw normalizeAdapterError(error, 'verify_transaction');
    }
  }

  async createRequest(id: string, input: PaymentRequest): Promise<AdapterPaymentDetails> {
    const adapter = this.getForNewPayments(id);
    const capabilities = adapter.manifest.capabilities;
    if (!capabilities.paymentRequests || !capabilities.currencies.includes(input.currency)) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'The selected payment method does not support this currency');
    }
    try {
      const details = await adapter.createRequest(input);
      if (details.adapter !== adapter.id || !details.network || !capabilities.networks.includes(details.network) ||
          details.currency !== input.currency || !capabilities.currencies.includes(details.currency) || !details.recipientAddress ||
          !/^[0-9]+$/.test(details.amountBaseUnits) || BigInt(details.amountBaseUnits) <= 0n ||
          (details.tokenAddress !== null && typeof details.tokenAddress !== 'string') ||
          !isRecord(details.adapterData)) {
        throw new PaymentAdapterError('invalid_response', 'create_request', 'Payment adapter returned invalid payment details');
      }
      return details;
    } catch (error) {
      throw normalizeAdapterError(error, 'create_request');
    }
  }

  async verifyTransaction(id: string, input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    const adapter = this.getForVerification(id);
    if (!adapter.manifest.capabilities.transactionVerification) {
      throw new PaymentAdapterError('unavailable', 'verify_transaction', 'Transaction verification is unavailable for this payment method');
    }
    if (!adapter.manifest.capabilities.currencies.includes(input.currency) || !adapter.manifest.capabilities.networks.includes(input.network)) {
      throw new PaymentAdapterError('invalid_request', 'verify_transaction', 'The payment method does not support this payment asset or network');
    }
    try {
      const result = await adapter.verifyTransaction(input);
      return this.validateVerificationResult(input, result);
    } catch (error) {
      throw normalizeAdapterError(error, 'verify_transaction');
    }
  }

  async pollPaymentStatus(
    id: string,
    input: Omit<PaymentVerificationInput, 'transactionId'>,
  ): Promise<PaymentStatusPollResult | null> {
    const adapter = this.getForVerification(id);
    if (!adapter.manifest.capabilities.statusPolling || !adapter.pollPaymentStatus) return null;
    try {
      const polled = await adapter.pollPaymentStatus(input);
      if (!polled) return null;
      const transactionId = adapter.normalizeTransactionId(polled.transactionId);
      if (!transactionId || transactionId.length > 512) {
        throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'Adapter returned an invalid polling transaction ID');
      }
      const normalizedInput = { ...input, transactionId };
      return { transactionId, result: this.validateVerificationResult(normalizedInput, polled.result) };
    } catch (error) {
      throw normalizeAdapterError(error, 'verify_transaction');
    }
  }

  async list(): Promise<PaymentAdapterSummary[]> {
    return Promise.all([...this.entries.values()].map(async (entry) => {
      let health: PaymentAdapterHealth;
      try {
        health = await entry.adapter.health();
      } catch {
        health = { status: 'unavailable', message: 'Adapter health check failed' };
      }
      const { manifest } = entry.adapter;
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        isDefault: entry.adapter.id === this.defaultAdapterId,
        status: entry.configuration.enabled ? 'enabled' : 'disabled',
        lifecycle: entry.lifecycle,
        capabilities: manifest.capabilities,
        idempotency: manifest.idempotency,
        health,
      };
    }));
  }

  async availableForCheckout(): Promise<Array<Pick<PaymentAdapterSummary,
    'id' | 'name' | 'description' | 'capabilities'>>> {
    const entries = [...this.entries.values()].filter((entry) =>
      entry.configuration.enabled && entry.lifecycle === 'ready' && entry.adapter.manifest.capabilities.paymentRequests);
    const available = await Promise.all(entries.map(async (entry) => {
      try {
        return (await entry.adapter.health()).status === 'healthy';
      } catch {
        return false;
      }
    }));
    return entries.flatMap((entry, index) => available[index]
      ? [{
          id: entry.adapter.manifest.id,
          name: entry.adapter.manifest.name,
          description: entry.adapter.manifest.description,
          capabilities: entry.adapter.manifest.capabilities,
        }]
      : []);
  }

  private getEntry(id: string): AdapterEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new PaymentAdapterError('unavailable', 'verify_transaction', `Payment adapter '${id}' is not installed`);
    return entry;
  }

  private validateVerificationResult(input: PaymentVerificationInput, result: PaymentVerificationResult): PaymentVerificationResult {
    if (result.state !== 'not_found' && result.state !== 'rejected') {
      const receipt = result.receipt;
      if (receipt.transactionId !== input.transactionId || receipt.network !== input.network ||
          receipt.amount !== input.amount || receipt.currency !== input.currency || receipt.recipient !== input.recipientAddress ||
          !Number.isInteger(receipt.confirmations) || receipt.confirmations < 0 ||
          (receipt.blockNumber !== null && !/^[0-9]+$/.test(receipt.blockNumber)) ||
          (result.state === 'verified' && receipt.state !== 'confirmed') ||
          (result.state === 'failed' && receipt.state !== 'failed') ||
          (result.state === 'pending' && receipt.state !== 'pending')) {
        throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'Payment adapter returned an invalid transaction receipt');
      }
    }
    return result;
  }

  private validateRegistration(adapter: PaymentAdapter, configuration: PaymentAdapterConfiguration): void {
    const { manifest } = adapter;
    if (!configuration || typeof configuration.enabled !== 'boolean' || !isRecord(configuration.settings)) {
      throw new Error('Payment adapter configuration must define enabled and an object of settings');
    }
    const capabilities = manifest.capabilities;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(adapter.id) || manifest.id !== adapter.id ||
        !manifest.name.trim() || !manifest.version.trim() || !manifest.description.trim() ||
        typeof adapter.normalizeTransactionId !== 'function' ||
        !capabilities ||
        ['paymentRequests', 'transactionVerification', 'statusPolling', 'recurringPayments', 'automaticDetection', 'refunds']
          .some((key) => typeof capabilities[key as keyof typeof capabilities] !== 'boolean') ||
        !['wallet', 'invoice'].includes(capabilities.paymentRequestFormat) ||
        !Array.isArray(capabilities.currencies) || capabilities.currencies.length === 0 ||
        !capabilities.currencies.every((item) => typeof item === 'string' && /^[A-Z][A-Z0-9]{2,11}$/.test(item)) ||
        !Array.isArray(capabilities.networks) || capabilities.networks.length === 0 ||
        !capabilities.networks.every((item) => typeof item === 'string' && item.length > 0) ||
        manifest.idempotency?.paymentCreation !== 'stable-key-required' ||
        manifest.idempotency?.transactionVerification !== 'network-and-transaction-id') {
      throw new Error('Payment adapter manifest is invalid');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
