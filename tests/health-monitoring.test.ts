import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../src/payment-adapter.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import { AiProviderRegistry } from '../src/ai-providers/registry.js';
import { SmsProviderRegistry } from '../src/sms-providers/registry.js';
import { HealthService } from '../src/services/health-service.js';
import { MockAiProvider } from './fixtures/mock-ai-provider.js';
import { MockSmsProvider } from './fixtures/mock-sms-provider.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913';

function pgAdapterPool(memory: ReturnType<typeof newDb>): Pool {
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function createDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = pgAdapterPool(memory);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  let phaseOne = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
  phaseOne = phaseOne.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? phaseOne;
  await pool.query(phaseOne);
  const phaseTwo = await readFile(path.join(migrationsDir, '0002_usdc_base.sql'), 'utf8');
  const backfillStart = phaseTwo.indexOf('UPDATE payments\n   SET adapter_data = jsonb_build_object');
  if (backfillStart >= 0) {
    const backfillEnd = phaseTwo.indexOf(';', backfillStart);
    await pool.query(phaseTwo.slice(0, backfillStart) + phaseTwo.slice(backfillEnd + 1));
  } else {
    await pool.query(phaseTwo);
  }
  let webhookMigration = await readFile(path.join(migrationsDir, '0003_webhooks.sql'), 'utf8');
  webhookMigration = webhookMigration.replace(
    /event_type text NOT NULL CHECK \(event_type IN \([\s\S]*?\)\),/,
    'event_type text NOT NULL,',
  );
  await pool.query(webhookMigration);
  for (const migration of ['0004_credit_engine.sql', '0005_ai_pricing.sql', '0006_invoices_receipts.sql',
    '0007_subscriptions.sql', '0008_ai_provider_integration.sql', '0009_sms_otp.sql',
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql', '0012_payment_links.sql',
    '0013_merchant_settings.sql', '0014_notification_preferences.sql']) {
    await pool.query(await readFile(path.join(migrationsDir, migration), 'utf8'));
  }
  return {
    query: (text, values = []) => pool.query(text, values),
    transaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  } as Database;
}

function stubAdapter(healthMessage = 'Test adapter is ready'): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'test', description: 'Test Base USDC adapter',
      capabilities: {
        paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
        automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet',
        currencies: ['USDC'], networks: ['base'],
      },
      idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
    },
    initialize: async () => {},
    shutdown: async () => {},
    health: async () => ({ status: 'healthy', message: healthMessage }),
    normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
    createRequest: vi.fn(async (input): Promise<AdapterPaymentDetails> => ({
      adapter: 'usdc', network: 'base', currency: 'USDC',
      recipientAddress: input.recipient.toLowerCase(), tokenAddress: usdcAddress.toLowerCase(),
      amountBaseUnits: parseUnits(input.amount, 6).toString(), adapterData: { chainId: 8453, decimals: 6 },
    })),
    verifyTransaction: async () => ({ state: 'not_found' }),
  };
}

async function registries(options: {
  adapterHealthMessage?: string;
  ai?: MockAiProvider;
  sms?: MockSmsProvider;
  aiEnabled?: boolean;
  smsEnabled?: boolean;
  secret?: string;
} = {}) {
  const adapters = new PaymentAdapterRegistry();
  adapters.register(stubAdapter(options.adapterHealthMessage), { enabled: true, settings: {}, isDefault: true });
  await adapters.initialize();
  const aiProviders = new AiProviderRegistry();
  aiProviders.register(options.ai ?? new MockAiProvider(), {
    enabled: options.aiEnabled ?? true, settings: { apiKey: options.secret ?? 'test-ai-key' },
  });
  await aiProviders.initialize();
  const smsProviders = new SmsProviderRegistry();
  smsProviders.register(options.sms ?? new MockSmsProvider('mock-sms', 'Mock SMS'), {
    enabled: options.smsEnabled ?? true, settings: { apiKey: options.secret ?? 'test-sms-key' },
  });
  await smsProviders.initialize();
  return { adapters, aiProviders, smsProviders };
}

describe('production health monitoring', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function build(options: Parameters<typeof registries>[0] = {}) {
    const { adapters, aiProviders, smsProviders } = await registries(options);
    app = await buildApp({ db, adapterRegistry: adapters, aiProviderRegistry: aiProviders, smsProviderRegistry: smsProviders });
  }

  beforeEach(async () => {
    db = await createDatabase();
    await build();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('reports a healthy state with safe operational data', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health', headers: adminHeaders });
    expect(response.statusCode, response.body).toBe(200);
    const health = response.json();
    expect(health.status).toBe('healthy');
    expect(health.api).toMatchObject({ status: 'healthy', service: 'tariffia-pay-api' });
    expect(typeof health.api.version).toBe('string');
    expect(health.api.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.database).toMatchObject({ status: 'healthy' });
    expect(typeof health.database.latencyMs).toBe('number');
    expect(health.paymentAdapters[0]).toMatchObject({
      id: 'usdc', name: 'Base USDC', enabled: true, lifecycle: 'ready', health: { status: 'healthy' },
    });
    expect(health.lightning).toMatchObject({ installed: false, enabled: false, providerType: 'none' });
    expect(health.aiProviders[0]).toMatchObject({ id: 'mock-ai', enabled: true, configured: true, health: { status: 'healthy' } });
    expect(health.smsProviders[0]).toMatchObject({ id: 'mock-sms', enabled: true, configured: true });

    const liveness = await app.inject({ method: 'GET', url: '/health' });
    expect(liveness.json()).toMatchObject({ status: 'ok', service: 'tariffia-pay-api' });
    expect(typeof liveness.json().version).toBe('string');
    const readiness = await app.inject({ method: 'GET', url: '/ready' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ status: 'ready', service: 'tariffia-pay-api', checks: { database: 'healthy', paymentAdapters: 'healthy' } });
  });

  it('reports database unavailability and keeps readiness failing without leaking errors', async () => {
    const originalQuery = db.query;
    db.query = (async () => { throw new Error('private database connection detail'); }) as Database['query'];
    try {
      const health = await app.inject({ method: 'GET', url: '/v1/health', headers: adminHeaders });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: 'unavailable', database: { status: 'unavailable' } });
      expect(health.body).not.toContain('private database connection detail');

      const readiness = await app.inject({ method: 'GET', url: '/ready' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({ status: 'not_ready', service: 'tariffia-pay-api' });
      expect(readiness.body).not.toContain('private database connection detail');

      // Liveness stays up even when the database is down.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      db.query = originalQuery;
    }
  });

  it('distinguishes disabled providers from enabled but unconfigured ones', async () => {
    await app.close();
    await build({ aiEnabled: false, smsEnabled: false });
    const disabled = (await app.inject({ method: 'GET', url: '/v1/health', headers: adminHeaders })).json();
    expect(disabled.status).toBe('healthy');
    expect(disabled.aiProviders[0]).toMatchObject({ id: 'mock-ai', enabled: false });
    expect(disabled.smsProviders[0]).toMatchObject({ id: 'mock-sms', enabled: false });

    await app.close();
    const unconfigured = new MockAiProvider();
    unconfigured.options = { configured: false };
    await build({ ai: unconfigured });
    const degraded = (await app.inject({ method: 'GET', url: '/v1/health', headers: adminHeaders })).json();
    expect(degraded.status).toBe('degraded');
    expect(degraded.aiProviders[0]).toMatchObject({ id: 'mock-ai', enabled: true, configured: false });
    // Readiness never depends on optional providers.
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('redacts credentials and credential-bearing URLs from health output', async () => {
    await app.close();
    const secret = 'sk-live-health-secret-abcdefghijklmnop';
    const leaky = new MockAiProvider();
    leaky.options = { health: { status: 'healthy', message: 'Reachable at https://user:pass@provider.example now' } };
    await build({ ai: leaky, secret });
    for (const url of ['/v1/health', '/health', '/ready']) {
      const headers = url === '/v1/health' ? adminHeaders : {};
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.body, url).not.toContain(secret);
      expect(response.body, url).not.toContain('user:pass');
      expect(response.body, url).not.toContain('Bearer test-');
    }
    const health = (await app.inject({ method: 'GET', url: '/v1/health', headers: adminHeaders })).json();
    expect(health.aiProviders[0].health.message).toContain('[redacted]@provider.example');
  });

  it('requires the admin key for the operational summary but keeps liveness and readiness public', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/health', headers: { 'x-admin-api-key': 'wrong' } })).statusCode).toBe(401);
    const merchantKey = (await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'Health Store', email: 'health@example.com', walletAddress: '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a' },
    })).json().apiKey as string;
    expect((await app.inject({ method: 'GET', url: '/v1/health', headers: { authorization: `Bearer ${merchantKey}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('fails readiness and degrades health when an enabled payment adapter is not ready', async () => {
    const failedRegistry = {
      list: async () => [{
        id: 'usdc', name: 'Base USDC', version: 'test', description: 'stub', isDefault: true,
        status: 'enabled', lifecycle: 'failed',
        capabilities: { paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false, automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet', currencies: ['USDC'], networks: ['base'] },
        idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
        health: { status: 'unavailable', message: 'not ready' },
      }],
    };
    const emptyAi = { list: async () => [] };
    const emptySms = { list: async () => [] };
    const service = new HealthService(
      db,
      failedRegistry as unknown as PaymentAdapterRegistry,
      emptyAi as unknown as AiProviderRegistry,
      emptySms as unknown as SmsProviderRegistry,
    );
    const readiness = await service.readiness();
    expect(readiness).toMatchObject({ ready: false, checks: { database: 'healthy', paymentAdapters: 'unavailable' } });
    expect((await service.summary()).status).toBe('degraded');
  });
});
