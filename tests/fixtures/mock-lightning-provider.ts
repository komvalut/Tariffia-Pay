import { createHash } from 'node:crypto';
import type {
  LightningInvoice,
  LightningInvoiceRequest,
  LightningProvider,
  LightningProviderPayment,
  LightningProviderPaymentState,
} from '../../src/adapters/lightning-provider.js';

export class MockLightningProvider implements LightningProvider {
  readonly createCalls: LightningInvoiceRequest[] = [];
  readonly invoicesCreated = new Map<string, LightningInvoice>();
  private readonly invoicesByKey = new Map<string, LightningInvoice>();
  private readonly payments = new Map<string, LightningProviderPayment>();
  createFailure?: Error;
  lookupFailure?: Error;
  healthFailure?: Error;
  available = true;

  async createInvoice(input: LightningInvoiceRequest): Promise<LightningInvoice> {
    this.createCalls.push(input);
    if (this.createFailure) throw this.createFailure;
    const previous = this.invoicesByKey.get(input.idempotencyKey);
    if (previous) {
      if (previous.amountMsat !== input.amountMsat || previous.network !== input.network) {
        throw new Error('Idempotency key reused with different invoice data');
      }
      return previous;
    }
    const paymentHash = createHash('sha256').update(input.idempotencyKey).digest('hex');
    const invoice: LightningInvoice = {
      paymentRequest: `lnmock_${input.network}_${paymentHash}`,
      paymentHash,
      amountMsat: input.amountMsat,
      network: input.network,
      expiresAt: input.expiresAt,
      providerReference: `mock-${paymentHash.slice(0, 12)}`,
    };
    this.invoicesByKey.set(input.idempotencyKey, invoice);
    this.invoicesCreated.set(paymentHash, invoice);
    this.payments.set(paymentHash, {
      paymentHash,
      amountMsat: input.amountMsat,
      network: input.network,
      state: 'pending',
      expiresAt: input.expiresAt,
    });
    return invoice;
  }

  async getPayment(paymentHash: string): Promise<LightningProviderPayment | null> {
    if (this.lookupFailure) throw this.lookupFailure;
    return this.payments.get(paymentHash) ?? null;
  }

  async health(): Promise<{ available: boolean }> {
    if (this.healthFailure) throw this.healthFailure;
    return { available: this.available };
  }

  async shutdown(): Promise<void> {}

  setState(paymentHash: string, state: LightningProviderPaymentState, paidAmountMsat?: string, settledAt?: string): void {
    const current = this.payments.get(paymentHash);
    if (!current) throw new Error('Mock Lightning payment not found');
    this.payments.set(paymentHash, {
      ...current,
      state,
      ...(state === 'settled'
        ? { paidAmountMsat: paidAmountMsat ?? current.amountMsat, settledAt: settledAt ?? new Date().toISOString() }
        : {}),
    });
  }
}
