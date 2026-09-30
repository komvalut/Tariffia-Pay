import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LndRestLightningProvider, type LndRestLightningProviderSettings } from '../src/adapters/lnd-rest-provider.js';

const baseSettings: LndRestLightningProviderSettings = {
  url: 'https://lnd.example.test/base/',
  macaroonHex: 'ab'.repeat(32),
  idempotencySecretHex: 'cd'.repeat(32),
  timeoutMs: 100,
  nodeEnv: 'production',
  network: 'mainnet',
};

class LndRestFixture {
  readonly calls: Array<{ url: URL; init: RequestInit }> = [];
  readonly invoices = new Map<string, Record<string, unknown>>();
  failAfterCreatingInvoice = false;
  wrongReturnedHash = false;
  synced = true;

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    this.calls.push({ url, init });
    if (url.pathname.endsWith('/v1/getinfo')) {
      return this.json({
        identity_pubkey: 'node-identity', synced_to_chain: this.synced,
        chains: [{ chain: 'bitcoin', network: 'mainnet' }],
      });
    }
    if (url.pathname.endsWith('/v1/invoices') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { r_preimage: string; value_msat: string; expiry: number };
      const preimage = Buffer.from(body.r_preimage, 'base64');
      const paymentHash = createHash('sha256').update(preimage).digest('hex');
      const nowSeconds = Math.floor(Date.now() / 1000);
      const invoice: Record<string, unknown> = {
        r_hash: Buffer.from(this.wrongReturnedHash ? 'f'.repeat(64) : paymentHash, 'hex').toString('base64'),
        payment_request: `lnbc${body.value_msat}p1${paymentHash}`,
        value_msat: body.value_msat,
        amount_msat: body.value_msat,
        creation_date: String(nowSeconds),
        expiry: String(body.expiry),
        state: 'OPEN',
        settled: false,
        amt_paid_msat: '0',
        settle_date: '0',
        add_index: '42',
      };
      this.invoices.set(paymentHash, invoice);
      if (this.failAfterCreatingInvoice) {
        this.failAfterCreatingInvoice = false;
        throw new Error('simulated socket loss; Grpc-Metadata-macaroon=credential-marker');
      }
      return this.json({
        r_hash: invoice.r_hash,
        payment_request: invoice.payment_request,
        add_index: invoice.add_index,
      });
    }
    const invoiceMatch = url.pathname.match(/\/v1\/invoice\/([0-9a-f]{64})$/);
    if (invoiceMatch) {
      const invoice = this.invoices.get(invoiceMatch[1]!);
      return invoice ? this.json(invoice) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };

  setInvoiceState(paymentHash: string, state: string, paidAmountMsat?: string): void {
    const invoice = this.invoices.get(paymentHash);
    if (!invoice) throw new Error('Fixture invoice not found');
    invoice.state = state;
    invoice.settled = state === 'SETTLED';
    invoice.amt_paid_msat = paidAmountMsat ?? String(invoice.value_msat);
    invoice.settle_date = String(Math.floor(Date.now() / 1000));
  }

  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
}

function provider(fixture = new LndRestFixture(), settings: Partial<LndRestLightningProviderSettings> = {}) {
  return {
    fixture,
    instance: new LndRestLightningProvider({ ...baseSettings, ...settings }, fixture.fetch),
  };
}

function invoiceRequest() {
  return {
    paymentId: 'payment-1',
    idempotencyKey: 'stable-idempotency-hash-for-payment',
    amountMsat: '25000',
    memo: 'Order one',
    network: 'mainnet' as const,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

describe('LND REST production provider', () => {
  it('creates and looks up an invoice using the authenticated LND REST API', async () => {
    const { fixture, instance } = provider();
    const invoice = await instance.createInvoice(invoiceRequest());
    expect(invoice).toMatchObject({
      paymentRequest: expect.stringMatching(/^lnbc/), paymentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      amountMsat: '25000', network: 'mainnet', providerReference: '42',
    });
    const lookup = await instance.getPayment(invoice.paymentHash, 'mainnet');
    expect(lookup).toMatchObject({
      paymentHash: invoice.paymentHash, amountMsat: '25000', state: 'pending', network: 'mainnet',
      expiresAt: expect.any(String),
    });
    expect(Math.abs(Date.parse(lookup!.expiresAt) - Date.parse(invoice.expiresAt))).toBeLessThan(1000);
    const post = fixture.calls.find((call) => call.init.method === 'POST')!;
    expect(post.url.pathname).toBe('/base/v1/invoices');
    expect(post.init.redirect).toBe('error');
    expect(new Headers(post.init.headers).get('Grpc-Metadata-macaroon')).toBe(baseSettings.macaroonHex);
    expect(await instance.health()).toEqual({ available: true });
  });

  it('normalizes unpaid, paid and cancelled invoice states from LND', async () => {
    const { fixture, instance } = provider();
    const invoice = await instance.createInvoice(invoiceRequest());
    fixture.setInvoiceState(invoice.paymentHash, 'SETTLED', '25000');
    await expect(instance.getPayment(invoice.paymentHash, 'mainnet')).resolves.toMatchObject({
      state: 'settled', amountMsat: '25000', paidAmountMsat: '25000', settledAt: expect.any(String),
    });
    fixture.setInvoiceState(invoice.paymentHash, 'SETTLED', '24000');
    await expect(instance.getPayment(invoice.paymentHash, 'mainnet')).resolves.toMatchObject({ paidAmountMsat: '24000' });
    fixture.setInvoiceState(invoice.paymentHash, 'CANCELED');
    await expect(instance.getPayment(invoice.paymentHash, 'mainnet')).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('rejects mismatched payment hashes and malformed LND invoice data', async () => {
    const badHashFixture = new LndRestFixture();
    badHashFixture.wrongReturnedHash = true;
    const { instance: badHashProvider } = provider(badHashFixture);
    await expect(badHashProvider.createInvoice(invoiceRequest())).rejects.toMatchObject({
      code: 'invalid_response', message: 'LND returned an invalid invoice',
    });

    const { fixture, instance } = provider();
    const invoice = await instance.createInvoice(invoiceRequest());
    const raw = fixture.invoices.get(invoice.paymentHash)!;
    raw.r_hash = Buffer.from('e'.repeat(64), 'hex').toString('base64');
    await expect(instance.getPayment(invoice.paymentHash, 'mainnet')).rejects.toMatchObject({
      code: 'invalid_response', message: 'LND returned a different invoice hash',
    });
  });

  it('reuses a deterministic LND invoice after retry, including a lost create response', async () => {
    const fixture = new LndRestFixture();
    fixture.failAfterCreatingInvoice = true;
    const { instance } = provider(fixture);
    const first = await instance.createInvoice(invoiceRequest());
    const restartedProvider = new LndRestLightningProvider(baseSettings, fixture.fetch);
    const retry = await restartedProvider.createInvoice(invoiceRequest());
    expect(retry.paymentHash).toBe(first.paymentHash);
    expect(retry.paymentRequest).toBe(first.paymentRequest);
    expect(fixture.calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
    await instance.shutdown();
    await restartedProvider.shutdown();
  });

  it('times out safely and redacts credentials from provider errors', async () => {
    const secret = baseSettings.macaroonHex;
    const failingFetch: typeof fetch = async () => { throw new Error(`remote said ${secret}`); };
    const failing = new LndRestLightningProvider(baseSettings, failingFetch);
    const error = await failing.getPayment('a'.repeat(64), 'mainnet').catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'unavailable', message: 'LND provider connection failed' });
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);

    const timeoutFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('credential in low-level timeout')));
    });
    const timed = new LndRestLightningProvider({ ...baseSettings, timeoutMs: 100 }, timeoutFetch);
    await expect(timed.getPayment('b'.repeat(64), 'mainnet')).rejects.toMatchObject({
      code: 'unavailable', message: 'LND provider request timed out', retryable: true,
    });
  });

  it('rejects unsafe or incomplete provider configuration', () => {
    expect(() => new LndRestLightningProvider({ ...baseSettings, url: 'http://remote-node.example' }))
      .toThrow('must use HTTPS');
    expect(() => new LndRestLightningProvider({ ...baseSettings, url: 'https://user:pass@lnd.example' }))
      .toThrow('must use HTTPS');
    expect(() => new LndRestLightningProvider({ ...baseSettings, url: 'http://127.0.0.1:8080' })).not.toThrow();
    expect(() => new LndRestLightningProvider({ ...baseSettings, macaroonHex: 'not-a-macaroon' }))
      .toThrow('credentials or timeout configuration is invalid');
    expect(() => new LndRestLightningProvider({
      ...baseSettings, idempotencySecretHex: baseSettings.macaroonHex.slice(0, 64),
    })).toThrow('credentials or timeout configuration is invalid');
  });

  it('waits for active requests during graceful shutdown and refuses new calls afterward', async () => {
    let release!: (response: Response) => void;
    const waitingFetch: typeof fetch = async () => new Promise((resolve) => { release = resolve; });
    const lnd = new LndRestLightningProvider(baseSettings, waitingFetch);
    const request = lnd.getPayment('c'.repeat(64), 'mainnet');
    await Promise.resolve();
    let stopped = false;
    const shutdown = lnd.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(new Response(null, { status: 404 }));
    await expect(request).resolves.toBeNull();
    await shutdown;
    expect(stopped).toBe(true);
    await expect(lnd.getPayment('c'.repeat(64), 'mainnet')).rejects.toMatchObject({
      code: 'unavailable', message: 'LND provider is shutting down',
    });
  });
});
