import { config } from '../config.js';
import type { Database } from '../db.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';
import type { AiProviderRegistry } from '../ai-providers/registry.js';
import type { SmsProviderRegistry } from '../sms-providers/registry.js';
import { serviceVersion } from '../version.js';

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable';

type Dependency = { id: string; name: string; enabled: boolean; lifecycle: string; configured: boolean; health: { status: string; message: string } };

/** Strips credential-bearing URLs, bearer tokens and long opaque tokens from health messages. */
function sanitizeHealthMessage(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

function sanitizeDependency(item: Dependency): Dependency {
  return { ...item, health: { status: item.health.status, message: sanitizeHealthMessage(item.health.message) } };
}

export class HealthService {
  private readonly startedAt = new Date();

  constructor(
    private readonly db: Database,
    private readonly adapters: PaymentAdapterRegistry,
    private readonly aiProviders: AiProviderRegistry,
    private readonly smsProviders: SmsProviderRegistry,
  ) {}

  /** Database connectivity and latency; never exposes connection details. */
  async database(): Promise<{ status: HealthStatus; latencyMs?: number }> {
    const started = Date.now();
    try {
      await this.db.query('SELECT 1');
      return { status: 'healthy', latencyMs: Date.now() - started };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async dependencies(): Promise<{
    paymentAdapters: Dependency[];
    lightning: { installed: boolean; enabled: boolean; providerType: string; status: HealthStatus; health: { status: string; message: string } | null };
    aiProviders: Dependency[];
    smsProviders: Dependency[];
  }> {
    const adapterSummaries = await this.adapters.list();
    const paymentAdapters = adapterSummaries.map((adapter) => sanitizeDependency({
      id: adapter.id, name: adapter.name, enabled: adapter.status === 'enabled',
      lifecycle: adapter.lifecycle, configured: true, health: adapter.health,
    }));
    const lightningSummary = adapterSummaries.find((adapter) => adapter.id === 'lightning');
    const lightning = {
      installed: Boolean(lightningSummary),
      enabled: lightningSummary?.status === 'enabled',
      // Non-secret configuration label only; the provider URL, macaroon and secrets are never exposed.
      providerType: config.LIGHTNING_PROVIDER_TYPE,
      status: (lightningSummary?.health.status ?? 'unavailable') as HealthStatus,
      health: lightningSummary
        ? { status: lightningSummary.health.status, message: sanitizeHealthMessage(lightningSummary.health.message) }
        : null,
    };
    const aiProviders = (await this.aiProviders.list()).map((provider) => sanitizeDependency({
      id: provider.id, name: provider.name, enabled: provider.status === 'enabled',
      lifecycle: provider.lifecycle, configured: provider.configured, health: provider.health,
    }));
    const smsProviders = (await this.smsProviders.list()).map((provider) => sanitizeDependency({
      id: provider.id, name: provider.name, enabled: provider.status === 'enabled',
      lifecycle: provider.lifecycle, configured: provider.configured, health: provider.health,
    }));
    return { paymentAdapters, lightning, aiProviders, smsProviders };
  }

  /**
   * Full operational summary for administrators. Reports healthy/degraded/unavailable and
   * includes only safe data: identifiers, enabled/configured flags, lifecycle, bounded health
   * messages, version and uptime. It never includes secrets, credentials or provider URLs.
   */
  async summary() {
    const database = await this.database();
    const dependencies = await this.dependencies();
    const enabled = (items: Dependency[]) => items.filter((item) => item.enabled);
    const unreadyPayments = enabled(dependencies.paymentAdapters)
      .filter((item) => item.lifecycle !== 'ready' || !item.configured || item.health.status !== 'healthy');
    const unhealthyAi = enabled(dependencies.aiProviders)
      .filter((item) => item.lifecycle !== 'ready' || !item.configured || item.health.status !== 'healthy');
    const unhealthySms = enabled(dependencies.smsProviders)
      .filter((item) => item.lifecycle !== 'ready' || !item.configured || item.health.status !== 'healthy');
    const status: HealthStatus = database.status !== 'healthy'
      ? 'unavailable'
      : unreadyPayments.length || unhealthyAi.length || unhealthySms.length
        ? 'degraded'
        : 'healthy';
    return {
      status,
      api: {
        status: 'healthy' as HealthStatus,
        service: 'tariffia-pay-api',
        version: serviceVersion,
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: this.startedAt.toISOString(),
      },
      database,
      paymentAdapters: dependencies.paymentAdapters,
      lightning: dependencies.lightning,
      aiProviders: dependencies.aiProviders,
      smsProviders: dependencies.smsProviders,
    };
  }

  /**
   * Readiness depends on required infrastructure: the database and, when any payment method
   * is enabled, that those adapters completed initialization. Optional AI/SMS providers are
   * not required for readiness and never make it fail.
   */
  async readiness(): Promise<{ ready: boolean; checks: { database: HealthStatus; paymentAdapters: HealthStatus } }> {
    const database = await this.database();
    if (database.status !== 'healthy') {
      return { ready: false, checks: { database: database.status, paymentAdapters: 'unavailable' } };
    }
    const adapterSummaries = await this.adapters.list();
    const enabled = adapterSummaries.filter((adapter) => adapter.status === 'enabled');
    const paymentAdapters: HealthStatus = enabled.some((adapter) => adapter.lifecycle !== 'ready') ? 'unavailable' : 'healthy';
    return { ready: paymentAdapters === 'healthy', checks: { database: 'healthy', paymentAdapters } };
  }
}
