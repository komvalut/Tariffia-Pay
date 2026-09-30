import { z } from 'zod';
import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentAdapterHealth,
  PaymentAdapterManifest,
  PaymentRequest,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../payment-adapter.js';
import { PaymentAdapterError, normalizeAdapterError } from '../payment-adapters/errors.js';
import type { LightningBitcoinNetwork, LightningProvider } from './lightning-provider.js';
import { config } from '../config.js';

const millisatoshisPerSatoshi = 1000n;
const maximumInvoiceAmountMsat = (1n << 64n) - 1n;
const maximumInvoiceAmountSats = maximumInvoiceAmountMsat / millisatoshisPerSatoshi;

const settingsSchema = z.object({
  network: z.enum(['mainnet', 'testnet', 'signet']),
  minimumAmountSats: z.number().int().min(1),
  maximumAmountSats: z.number().int().min(1),
  invoiceExpirySeconds: z.number().int().min(60).max(604_800),
}).strict().refine((settings) => settings.minimumAmountSats <= settings.maximumAmountSats, {
  message: 'minimumAmountSats must not exceed maximumAmountSats',
}).refine((settings) => BigInt(settings.maximumAmountSats) <= maximumInvoiceAmountSats, {
  message: 'maximumAmountSats exceeds the Lightning invoice amount limit',
});

export type LightningAdapterSettings = z.infer<typeof settingsSchema>;

export function lightningAdapterSettings(): Record<string, unknown> {
  return {
    network: config.LIGHTNING_NETWORK,
    minimumAmountSats: config.LIGHTNING_MINIMUM_AMOUNT_SATS,
    maximumAmountSats: config.LIGHTNING_MAXIMUM_AMOUNT_SATS,
    invoiceExpirySeconds: config.LIGHTNING_INVOICE_EXPIRY_SECONDS,
  };
}

const manifest: PaymentAdapterManifest = {
  id: 'lightning',
  name: 'Bitcoin Lightning',
  version: '0.1.0',
  description: 'Lightning invoice payments through a configured provider.',
  capabilities: {
    paymentRequests: true,
    transactionVerification: true,
    automaticDetection: false,
    refunds: false,
    currencies: ['SAT'],
    networks: ['lightning-mainnet', 'lightning-testnet', 'lightning-signet'],
  },
  idempotency: {
    paymentCreation: 'stable-key-required',
    transactionVerification: 'network-and-transaction-id',
  },
};

export class LightningAdapter implements PaymentAdapter {
  readonly id = manifest.id;
  readonly manifest = manifest;
  private settings?: LightningAdapterSettings;
  private initialized = false;

  constructor(private readonly provider?: LightningProvider) {}

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    this.initialized = false;
    this.settings = undefined;
    const parsed = settingsSchema.safeParse(settings);
    if (!parsed.success) {
      throw new PaymentAdapterError('invalid_configuration', 'initialize', 'Lightning adapter configuration is invalid');
    }
    this.settings = parsed.data;
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    await this.provider?.shutdown();
  }

  async health(): Promise<PaymentAdapterHealth> {
    if (!this.initialized) return { status: 'unavailable', message: 'Lightning adapter is not initialized' };
    if (!this.provider) return { status: 'unavailable', message: 'No Lightning provider is configured' };
    try {
      const health = await this.provider.health();
      return health.available
        ? { status: 'healthy', message: 'Lightning provider is available' }
        : { status: 'unavailable', message: 'Lightning provider is unavailable' };
    } catch {
      return { status: 'unavailable', message: 'Lightning provider health check failed' };
    }
  }

  normalizeTransactionId(transactionId: string): string {
    return transactionId.toLowerCase();
  }

  async createRequest(input: PaymentRequest): Promise<AdapterPaymentDetails> {
    const settings = this.requireSettings();
    if (input.currency !== 'SAT') {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning payments require SAT amounts');
    }
    if (!/^[1-9][0-9]*$/.test(input.amount)) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning amount must be a positive whole number of satoshis');
    }
    const amountSats = BigInt(input.amount);
    if (amountSats < BigInt(settings.minimumAmountSats) || amountSats > BigInt(settings.maximumAmountSats)) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning amount is outside the configured satoshi limits');
    }
    const amountMsat = (amountSats * millisatoshisPerSatoshi).toString();
    const expiresAt = this.invoiceExpiry(input.expiresAt, settings.invoiceExpirySeconds);
    const provider = this.requireProvider('create_request');

    let invoice;
    try {
      invoice = await provider.createInvoice({
        paymentId: input.paymentId,
        idempotencyKey: input.idempotencyKey,
        amountMsat,
        memo: input.description ?? '',
        network: settings.network,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      throw normalizeAdapterError(error, 'create_request');
    }

    if (!invoice || typeof invoice.paymentRequest !== 'string' || !invoice.paymentRequest || invoice.paymentRequest.length > 4096 ||
        !/^[0-9a-fA-F]{64}$/.test(invoice.paymentHash) || invoice.amountMsat !== amountMsat ||
        invoice.network !== settings.network || !Number.isFinite(Date.parse(invoice.expiresAt)) ||
        Date.parse(invoice.expiresAt) <= Date.now() || Date.parse(invoice.expiresAt) > expiresAt.getTime()) {
      throw new PaymentAdapterError('invalid_response', 'create_request', 'Lightning provider returned an invalid invoice');
    }

    return {
      adapter: this.id,
      network: this.networkName(settings.network),
      currency: 'SAT',
      recipientAddress: invoice.paymentRequest,
      tokenAddress: null,
      amountBaseUnits: amountMsat,
      adapterData: {
        paymentHash: invoice.paymentHash.toLowerCase(),
        ...(invoice.providerReference ? { providerReference: invoice.providerReference } : {}),
        expiresAt: invoice.expiresAt,
      },
    };
  }

  async verifyTransaction(input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    const settings = this.requireSettings();
    const paymentHash = input.adapterData.paymentHash;
    if (input.currency !== 'SAT' || input.network !== this.networkName(settings.network) ||
        input.tokenAddress !== null || typeof paymentHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(paymentHash) || this.normalizeTransactionId(input.transactionId) !== paymentHash) {
      return { state: 'rejected', reason: 'Lightning payment identifier does not match its invoice' };
    }
    if (!/^[1-9][0-9]*$/.test(input.amount) || !/^[0-9]+$/.test(input.amountBaseUnits) ||
        BigInt(input.amount) * millisatoshisPerSatoshi !== BigInt(input.amountBaseUnits)) {
      return { state: 'rejected', reason: 'Lightning payment amount does not match the invoice unit representation' };
    }

    const provider = this.requireProvider('verify_transaction');
    let payment;
    try {
      payment = await provider.getPayment(paymentHash, settings.network);
    } catch (error) {
      throw normalizeAdapterError(error, 'verify_transaction');
    }
    if (!payment) return this.pendingReceipt(input);
    if (typeof payment.paymentHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payment.paymentHash) ||
        payment.paymentHash.toLowerCase() !== paymentHash || payment.network !== settings.network ||
        !/^[0-9]+$/.test(payment.amountMsat) || !Number.isFinite(Date.parse(payment.expiresAt))) {
      throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'Lightning provider returned a mismatched payment');
    }
    const storedExpiry = input.adapterData.expiresAt;
    if (typeof storedExpiry !== 'string' || !Number.isFinite(Date.parse(storedExpiry)) ||
        Math.abs(Date.parse(payment.expiresAt) - Date.parse(storedExpiry)) > 2000) {
      throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'Lightning provider returned a mismatched invoice expiry');
    }
    if (payment.state === 'expired' || payment.state === 'cancelled') {
      return { state: 'rejected', reason: 'Lightning invoice is no longer payable' };
    }
    if (payment.state !== 'pending' && payment.state !== 'settled') {
      throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'Lightning provider returned an unknown payment status');
    }
    if (payment.amountMsat !== input.amountBaseUnits) {
      return { state: 'rejected', reason: 'Lightning invoice amount does not match the payment' };
    }
    if (payment.state === 'pending') {
      if (Date.now() >= Date.parse(payment.expiresAt)) {
        return { state: 'rejected', reason: 'Lightning invoice has expired' };
      }
      return this.pendingReceipt(input);
    }
    const settledAt = payment.settledAt ? Date.parse(payment.settledAt) : Number.NaN;
    if (!Number.isFinite(settledAt) || settledAt > Date.parse(payment.expiresAt)) {
      return { state: 'rejected', reason: 'Lightning invoice settled after its expiry' };
    }
    if (payment.paidAmountMsat !== input.amountBaseUnits) {
      return { state: 'rejected', reason: 'Lightning settlement amount does not match the invoice' };
    }
    return {
      state: 'verified',
      receipt: {
        transactionId: paymentHash,
        network: input.network,
        state: 'confirmed',
        amount: input.amount,
        currency: input.currency,
        recipient: input.recipientAddress,
        confirmations: 1,
        blockNumber: null,
      },
    };
  }

  private pendingReceipt(input: PaymentVerificationInput): PaymentVerificationResult {
    return {
      state: 'pending',
      detected: false,
      receipt: {
        transactionId: input.transactionId,
        network: input.network,
        state: 'pending',
        amount: input.amount,
        currency: input.currency,
        recipient: input.recipientAddress,
        confirmations: 0,
        blockNumber: null,
      },
    };
  }

  private invoiceExpiry(requestedExpiry: string | null, expirySeconds: number): Date {
    const configuredExpiry = Date.now() + expirySeconds * 1000;
    const requestedExpiryMs = requestedExpiry ? Date.parse(requestedExpiry) : configuredExpiry;
    if (!Number.isFinite(requestedExpiryMs) || requestedExpiryMs <= Date.now()) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning invoice expiry must be in the future');
    }
    return new Date(Math.min(requestedExpiryMs, configuredExpiry));
  }

  private networkName(network: LightningBitcoinNetwork): string {
    return `lightning-${network}`;
  }

  private requireSettings(): LightningAdapterSettings {
    if (!this.initialized || !this.settings) {
      throw new PaymentAdapterError('unavailable', 'create_request', 'Lightning adapter is not initialized');
    }
    return this.settings;
  }

  private requireProvider(operation: 'create_request' | 'verify_transaction'): LightningProvider {
    if (!this.provider) {
      throw new PaymentAdapterError('unavailable', operation, 'No Lightning provider is configured', true);
    }
    return this.provider;
  }
}
