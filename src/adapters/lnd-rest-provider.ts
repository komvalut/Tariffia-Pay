import { createHash, createHmac } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { config } from '../config.js';
import { PaymentAdapterError } from '../payment-adapters/errors.js';
import type {
  LightningBitcoinNetwork,
  LightningInvoice,
  LightningInvoiceRequest,
  LightningProvider,
  LightningProviderPayment,
} from './lightning-provider.js';

export type LndRestLightningProviderSettings = {
  url: string;
  macaroonHex: string;
  idempotencySecretHex: string;
  timeoutMs: number;
  nodeEnv: AppConfig['NODE_ENV'];
  network: LightningBitcoinNetwork;
};

type LndInvoice = Record<string, unknown>;
type ProviderOperation = 'create_request' | 'verify_transaction' | 'health';

export class LndRestLightningProvider implements LightningProvider {
  private readonly baseUrl: URL;
  private readonly idempotencySecret: Buffer;
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly settings: LndRestLightningProviderSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = validateSettings(settings);
    this.idempotencySecret = Buffer.from(settings.idempotencySecretHex, 'hex');
  }

  async createInvoice(input: LightningInvoiceRequest): Promise<LightningInvoice> {
    this.assertNetwork(input.network, 'create_request');
    if (!input.idempotencyKey || !/^\d+$/.test(input.amountMsat) || BigInt(input.amountMsat) <= 0n) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning invoice request is invalid');
    }
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning invoice expiry is invalid');
    }

    const preimage = createHmac('sha256', this.idempotencySecret).update(input.idempotencyKey).digest();
    const paymentHash = createHash('sha256').update(preimage).digest('hex');
    const existing = await this.lookupInvoice(paymentHash, 'create_request');
    if (existing) return this.invoiceFromExisting(existing, paymentHash, input);

    const expirySeconds = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
    try {
      const created = await this.requestJson('/v1/invoices', 'create_request', {
        method: 'POST',
        body: JSON.stringify({
          r_preimage: preimage.toString('base64'),
          value_msat: input.amountMsat,
          memo: input.memo,
          expiry: expirySeconds,
        }),
      });
      if (!created) throw new PaymentAdapterError('invalid_response', 'create_request', 'LND returned an empty invoice response');
      return this.invoiceFromCreated(created, paymentHash, input);
    } catch (error) {
      if (!(error instanceof PaymentAdapterError) || error.code !== 'unavailable') throw error;
      try {
        const recovered = await this.lookupInvoice(paymentHash, 'create_request');
        if (recovered) return this.invoiceFromExisting(recovered, paymentHash, input);
      } catch {
        // Preserve the original normalized failure when recovery lookup also fails.
      }
      throw error;
    }
  }

  async getPayment(paymentHash: string, network: LightningBitcoinNetwork): Promise<LightningProviderPayment | null> {
    this.assertNetwork(network, 'verify_transaction');
    if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
      throw new PaymentAdapterError('invalid_request', 'verify_transaction', 'Lightning payment hash is invalid');
    }
    const invoice = await this.lookupInvoice(paymentHash, 'verify_transaction');
    if (!invoice) return null;
    if (decodeHash(invoice.r_hash, 'verify_transaction') !== paymentHash) {
      throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'LND returned a different invoice hash');
    }

    const amountMsat = invoiceAmountMsat(invoice, 'verify_transaction');
    const rawState = typeof invoice.state === 'string' ? invoice.state.toUpperCase() : '';
    const state: LightningProviderPayment['state'] = invoice.settled === true || rawState === 'SETTLED'
      ? 'settled'
      : rawState === 'OPEN' || rawState === 'ACCEPTED'
        ? 'pending'
        : rawState === 'CANCELED'
          ? 'cancelled'
          : (() => { throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'LND returned an unknown invoice state'); })();

    const expiry = numberValue(invoice.creation_date);
    const expirySeconds = numberValue(invoice.expiry);
    if (expiry === null || expirySeconds === null) {
      throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'LND omitted invoice expiry information');
    }
    const expiresAt = new Date((expiry + expirySeconds) * 1000).toISOString();
    const result: LightningProviderPayment = { paymentHash, amountMsat, network, state, expiresAt };
    if (state === 'settled') {
      const paidAmountMsat = decimalString(invoice.amt_paid_msat);
      const settleDate = numberValue(invoice.settle_date);
      if (paidAmountMsat === null || settleDate === null) {
        throw new PaymentAdapterError('invalid_response', 'verify_transaction', 'LND omitted settlement verification data');
      }
      result.paidAmountMsat = paidAmountMsat;
      result.settledAt = new Date(settleDate * 1000).toISOString();
    }
    return result;
  }

  async health(): Promise<{ available: boolean }> {
    try {
      const info = await this.requestJson('/v1/getinfo', 'health');
      if (!info) return { available: false };
      const chains = Array.isArray(info.chains) ? info.chains : [];
      const correctNetwork = chains.some((item) => isRecord(item) && item.chain === 'bitcoin' && item.network === this.settings.network);
      return { available: correctNetwork && info.synced_to_chain === true };
    } catch {
      return { available: false };
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.inFlight]);
  }

  private async lookupInvoice(paymentHash: string, operation: ProviderOperation): Promise<LndInvoice | null> {
    return this.requestJson(
      `/v1/invoice/${encodeURIComponent(paymentHash)}`,
      operation,
      { method: 'GET' },
      true,
    );
  }

  private invoiceFromCreated(raw: LndInvoice, paymentHash: string, input: LightningInvoiceRequest): LightningInvoice {
    if (decodeHash(raw.r_hash, 'create_request') !== paymentHash || typeof raw.payment_request !== 'string' ||
        !raw.payment_request || !invoiceNetworkMatches(raw.payment_request, input.network)) {
      throw new PaymentAdapterError('invalid_response', 'create_request', 'LND returned an invalid invoice');
    }
    return {
      paymentRequest: raw.payment_request,
      paymentHash,
      amountMsat: input.amountMsat,
      network: input.network,
      expiresAt: input.expiresAt,
      ...(raw.add_index !== undefined ? { providerReference: String(raw.add_index) } : {}),
    };
  }

  private invoiceFromExisting(raw: LndInvoice, paymentHash: string, input: LightningInvoiceRequest): LightningInvoice {
    if (decodeHash(raw.r_hash, 'create_request') !== paymentHash || typeof raw.payment_request !== 'string' ||
        !raw.payment_request || !invoiceNetworkMatches(raw.payment_request, input.network) ||
        invoiceAmountMsat(raw, 'create_request') !== input.amountMsat) {
      throw new PaymentAdapterError('invalid_response', 'create_request', 'Existing LND invoice does not match the idempotent request');
    }
    const creationDate = numberValue(raw.creation_date);
    const expirySeconds = numberValue(raw.expiry);
    if (creationDate === null || expirySeconds === null) {
      throw new PaymentAdapterError('invalid_response', 'create_request', 'LND omitted invoice expiry information');
    }
    const providerExpiry = (creationDate + expirySeconds) * 1000;
    const requestExpiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(requestExpiry)) {
      throw new PaymentAdapterError('invalid_request', 'create_request', 'Lightning invoice expiry is invalid');
    }
    return {
      paymentRequest: raw.payment_request,
      paymentHash,
      amountMsat: input.amountMsat,
      network: input.network,
      expiresAt: new Date(Math.min(providerExpiry, requestExpiry)).toISOString(),
      ...(raw.add_index !== undefined ? { providerReference: String(raw.add_index) } : {}),
    };
  }

  private async requestJson(
    path: string,
    operation: ProviderOperation,
    init: RequestInit = { method: 'GET' },
    notFoundIsNull = false,
  ): Promise<LndInvoice | null> {
    if (this.closed) throw new PaymentAdapterError('unavailable', operation, 'LND provider is shutting down', true);
    const controller = new AbortController();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    this.inFlight.add(completed);
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const url = new URL(this.baseUrl);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
      const response = await this.fetcher(url, {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'Grpc-Metadata-macaroon': this.settings.macaroonHex,
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (notFoundIsNull && response.status === 404) return null;
      if (!response.ok) {
        throw new PaymentAdapterError('unavailable', operation, 'LND provider request was unsuccessful', true);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PaymentAdapterError('invalid_response', operation, 'LND provider returned invalid JSON');
      }
      if (!isRecord(body)) throw new PaymentAdapterError('invalid_response', operation, 'LND provider returned an invalid response');
      return body;
    } catch (error) {
      if (error instanceof PaymentAdapterError) throw error;
      if (controller.signal.aborted) {
        throw new PaymentAdapterError('unavailable', operation, 'LND provider request timed out', true);
      }
      throw new PaymentAdapterError('unavailable', operation, 'LND provider connection failed', true);
    } finally {
      clearTimeout(timeout);
      finish();
      this.inFlight.delete(completed);
    }
  }

  private assertNetwork(network: LightningBitcoinNetwork, operation: ProviderOperation): void {
    if (network !== this.settings.network) {
      throw new PaymentAdapterError('invalid_request', operation, 'Lightning request targets a different Bitcoin network');
    }
  }
}

export function createLightningProviderFromConfig(): LightningProvider | undefined {
  if (config.LIGHTNING_PROVIDER_TYPE === 'none') {
    if (config.LIGHTNING_ADAPTER_ENABLED) {
      throw new PaymentAdapterError('invalid_configuration', 'initialize', 'Enabled Lightning requires a configured provider');
    }
    return undefined;
  }
  return new LndRestLightningProvider({
    url: config.LIGHTNING_PROVIDER_URL,
    macaroonHex: config.LIGHTNING_PROVIDER_MACAROON,
    idempotencySecretHex: config.LIGHTNING_PROVIDER_IDEMPOTENCY_SECRET,
    timeoutMs: config.LIGHTNING_PROVIDER_TIMEOUT_MS,
    nodeEnv: config.NODE_ENV,
    network: config.LIGHTNING_NETWORK,
  });
}

function validateSettings(settings: LndRestLightningProviderSettings): URL {
  let url: URL;
  try {
    url = new URL(settings.url);
  } catch {
    throw new PaymentAdapterError('invalid_configuration', 'initialize', 'Lightning provider URL is invalid');
  }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && (url.protocol !== 'http:' || (settings.nodeEnv === 'production' && !isLoopback(url.hostname))))) {
    throw new PaymentAdapterError('invalid_configuration', 'initialize', 'Lightning provider URL must use HTTPS and contain no credentials or query data');
  }
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(settings.macaroonHex) ||
      !/^[0-9a-fA-F]{64}$/.test(settings.idempotencySecretHex) ||
      settings.macaroonHex.toLowerCase() === settings.idempotencySecretHex.toLowerCase() ||
      !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 100 || settings.timeoutMs > 60_000) {
    throw new PaymentAdapterError('invalid_configuration', 'initialize', 'Lightning provider credentials or timeout configuration is invalid');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function decodeHash(value: unknown, operation: ProviderOperation): string {
  if (typeof value !== 'string') throw new PaymentAdapterError('invalid_response', operation, 'LND omitted the payment hash');
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new PaymentAdapterError('invalid_response', operation, 'LND returned an invalid payment hash');
  return decoded.toString('hex');
}

function invoiceAmountMsat(invoice: LndInvoice, operation: ProviderOperation): string {
  const millisatoshis = decimalString(invoice.value_msat);
  if (millisatoshis !== null) return millisatoshis;
  const satoshis = decimalString(invoice.value);
  if (satoshis !== null) return (BigInt(satoshis) * 1000n).toString();
  throw new PaymentAdapterError('invalid_response', operation, 'LND omitted the invoice amount');
}

function decimalString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function invoiceNetworkMatches(paymentRequest: string, network: LightningBitcoinNetwork): boolean {
  const prefix = paymentRequest.slice(0, 5).toLowerCase();
  if (network === 'mainnet') return prefix.startsWith('lnbc');
  if (network === 'testnet') return prefix.startsWith('lntb') && !prefix.startsWith('lntbs');
  return prefix.startsWith('lntbs');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
