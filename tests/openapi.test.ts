import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { openApiDocument } from '../src/openapi.js';
import { merchantScopeForRoute } from '../src/scopes.js';

type ImplementedRoute = { method: string; serverPath: string; path: string };

// Parses the Fastify route tree (`:param` style) into method + templated paths so the test can
// compare implemented merchant routes against the OpenAPI document without a static list.
function parseImplementedRoutes(output: string): ImplementedRoute[] {
  const routes: ImplementedRoute[] = [];
  const stack: string[] = [];
  for (const raw of output.split('\n')) {
    const branch = raw.includes('├── ') ? '├── ' : raw.includes('└── ') ? '└── ' : null;
    if (!branch) continue;
    const index = raw.indexOf(branch);
    if (index % 4 !== 0) continue;
    const depth = index / 4;
    const rest = raw.slice(index + branch.length).trim();
    const withMethods = /^(.*)\s+\(([^)]*)\)$/.exec(rest);
    const segment = (withMethods ? withMethods[1]! : rest).trim();
    const methods = (withMethods?.[2] ?? '').split(',').map((method) => method.trim()).filter(Boolean);
    const serverPath = `${depth > 0 ? stack[depth - 1] ?? '' : ''}${segment}`;
    stack[depth] = serverPath;
    stack.length = depth + 1;
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, serverPath, path: serverPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}') });
    }
  }
  return routes;
}

function isMerchantRoute(route: ImplementedRoute): boolean {
  return route.serverPath.startsWith('/v1/')
    && !route.serverPath.startsWith('/v1/admin/')
    && !route.serverPath.startsWith('/v1/public/')
    && route.serverPath !== '/v1/health';
}

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
    '0013_merchant_settings.sql', '0014_notification_preferences.sql', '0015_audit_log.sql']) {
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

describe('OpenAPI documentation', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('serves the OpenAPI document and the docs viewer without authentication', async () => {
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.headers['content-type']).toContain('application/json');
    const document = spec.json();
    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.info.title).toBe('Tariffia Pay API');
    expect(document.paths).toBeTypeOf('object');
    expect(Object.keys(document.paths).length).toBeGreaterThan(40);

    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('/openapi.json');
    expect(docs.body).not.toContain('tf_live_');
  });

  it('documents every important public and merchant route', async () => {
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const operations = new Set<string>();
    for (const [routePath, methods] of Object.entries(document.paths)) {
      for (const method of Object.keys(methods as Record<string, unknown>)) {
        operations.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
    const required = [
      'GET /v1/orders', 'POST /v1/orders', 'GET /v1/orders/{orderId}',
      'GET /v1/payments/{paymentId}', 'GET /v1/payments/{paymentId}/details', 'POST /v1/payments/{paymentId}/verify',
      'GET /v1/payment-links', 'POST /v1/payment-links', 'GET /v1/payment-links/{paymentId}', 'PATCH /v1/payment-links/{paymentId}', 'DELETE /v1/payment-links/{paymentId}',
      'GET /v1/transactions', 'GET /v1/transactions/{paymentId}',
      'GET /v1/customers', 'POST /v1/customers', 'GET /v1/customers/{customerId}',
      'GET /v1/revenue/summary', 'GET /v1/revenue/history',
      'POST /v1/credits/topups', 'POST /v1/credits/deductions', 'GET /v1/credits/{customerId}/balance',
      'GET /v1/ai/models', 'POST /v1/ai/chat/completions', 'POST /v1/ai/chat/stream', 'POST /v1/ai/usage',
      'GET /v1/sms/services', 'POST /v1/sms/send', 'POST /v1/sms/otp',
      'GET /v1/webhooks', 'POST /v1/webhooks', 'PATCH /v1/webhooks/{endpointId}', 'DELETE /v1/webhooks/{endpointId}', 'GET /v1/webhooks/{endpointId}/deliveries',
      'GET /v1/subscription-plans', 'POST /v1/subscription-plans', 'GET /v1/subscriptions', 'POST /v1/subscriptions', 'PATCH /v1/subscriptions/{subscriptionId}',
      'GET /v1/settings', 'PUT /v1/settings',
      'GET /v1/notification-preferences', 'PUT /v1/notification-preferences',
      'GET /v1/usage',
      'GET /v1/audit-log', 'GET /v1/health',
      'GET /v1/dashboard/overview', 'GET /v1/dashboard/{collection}',
      'GET /v1/api-keys', 'POST /v1/api-keys', 'DELETE /v1/api-keys/{keyId}',
      'GET /v1/invoices', 'GET /v1/receipts', 'GET /v1/ledger',
      'GET /v1/public/payment-methods', 'GET /v1/public/payments/{paymentId}',
    ];
    for (const operation of required) expect(operations.has(operation), operation).toBe(true);
    // Every merchant operation declares the merchant bearer scheme.
    for (const routePath of ['/v1/orders', '/v1/transactions', '/v1/ai/models', '/v1/sms/services', '/v1/api-keys']) {
      const operations = document.paths[routePath];
      for (const operation of Object.values(operations) as Array<{ security?: unknown[] }>) {
        expect(operation.security).toEqual([{ merchantApiKey: [] }]);
      }
    }
    expect(document.components.securitySchemes.merchantApiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(document.components.securitySchemes.merchantApiKey).not.toHaveProperty('example');
  });

  it('never exposes secrets, credentials or private keys', async () => {
    const body = (await app.inject({ method: 'GET', url: '/openapi.json' })).body;
    expect(body).not.toMatch(/tf_live_/);
    expect(body).not.toMatch(/whsec[_-]/i);
    expect(body).not.toMatch(/sk-live|sk-[A-Za-z0-9]{20}/i);
    expect(body).not.toMatch(/-----BEGIN/);
    expect(body).not.toMatch(/privateKey/i);
    expect(body).not.toContain('dev-admin-key-change-this-before-deploy');
    expect(body).not.toContain('API_KEY_PEPPER');
    // The documented webhook secret field is a schema property, never a value.
    expect(body).toContain('"secret"');
    expect(body).not.toMatch(/"secret":\s*"[^"]+"/);
    // The admin security scheme is declared by header name only, never with an example value.
    expect(openApiDocument.components.securitySchemes.adminApiKey).toMatchObject({
      type: 'apiKey', in: 'header', name: 'x-admin-api-key',
    });
    expect(openApiDocument.components.securitySchemes.adminApiKey).not.toHaveProperty('example');
  });

  it('documents the audit-log and admin health endpoints with correct authentication', () => {
    const audit = openApiDocument.paths['/v1/audit-log'];
    expect(audit, 'GET /v1/audit-log is not documented').toBeDefined();
    expect(audit.get, 'GET /v1/audit-log operation is not documented').toBeDefined();
    expect(audit.get.security).toEqual([{ merchantApiKey: [] }]);
    expect(audit.get.parameters?.map((parameter) => parameter.name)).toEqual(expect.arrayContaining(['limit', 'offset']));
    expect(JSON.stringify(audit)).toContain('AuditEntry');

    const health = openApiDocument.paths['/v1/health'];
    expect(health, 'GET /v1/health is not documented').toBeDefined();
    expect(health.get, 'GET /v1/health operation is not documented').toBeDefined();
    expect(health.get.security).toEqual([{ adminApiKey: [] }]);
  });

  it('documents every implemented merchant /v1 route', () => {
    const routes = parseImplementedRoutes(app.printRoutes({ commonPrefix: false }));
    expect(routes.length).toBeGreaterThan(40);
    const merchantRoutes = routes.filter(isMerchantRoute);
    expect(merchantRoutes.length).toBeGreaterThan(40);

    const missing: string[] = [];
    for (const route of merchantRoutes) {
      const operations = (openApiDocument.paths as unknown as Record<string, Record<string, { security?: unknown }>>)[route.path];
      const operation = operations?.[route.method.toLowerCase()];
      if (!operation) {
        missing.push(`${route.method} ${route.path}`);
        continue;
      }
      // Every documented merchant operation must declare the merchant bearer scheme.
      expect(operation.security, `${route.method} ${route.path} must require the merchant API key`)
        .toEqual([{ merchantApiKey: [] }]);
      // Every merchant route must map to an enforceable scope.
      expect(merchantScopeForRoute(route.method, route.serverPath), `${route.method} ${route.serverPath} has no scope`)
        .toBeDefined();
    }
    expect(missing, `Merchant routes missing from OpenAPI: ${missing.join(', ')}`).toEqual([]);
  });
});
