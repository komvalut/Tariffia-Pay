import {
  SmsProviderError,
  type SmsProvider,
  type SmsProviderConfiguration,
  type SmsProviderHealth,
  type SmsProviderManifest,
} from '../sms-provider.js';

type SmsProviderEntry = {
  provider: SmsProvider;
  configuration: SmsProviderConfiguration;
  lifecycle: 'registered' | 'ready' | 'failed' | 'stopped';
};

export type SmsProviderSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: SmsProviderManifest['kind'];
  status: 'enabled' | 'disabled';
  lifecycle: SmsProviderEntry['lifecycle'];
  configured: boolean;
  capabilities: SmsProviderManifest['capabilities'];
  health: SmsProviderHealth;
};

export class SmsProviderRegistry {
  private readonly entries = new Map<string, SmsProviderEntry>();
  private initialized = false;

  register(provider: SmsProvider, configuration: SmsProviderConfiguration): void {
    if (this.initialized) throw new Error('SMS provider registry is already initialized');
    this.validateRegistration(provider, configuration);
    if (this.entries.has(provider.id)) throw new Error(`SMS provider '${provider.id}' is already registered`);
    this.entries.set(provider.id, { provider, configuration, lifecycle: 'registered' });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const entry of this.entries.values()) {
      try {
        await entry.provider.initialize(entry.configuration.settings);
        entry.lifecycle = 'ready';
      } catch (error) {
        entry.lifecycle = 'failed';
        throw error;
      }
    }
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    for (const entry of [...this.entries.values()].reverse()) {
      if (entry.lifecycle !== 'ready') continue;
      await entry.provider.shutdown();
      entry.lifecycle = 'stopped';
    }
    this.initialized = false;
  }

  getProvider(id: string): SmsProvider {
    return this.getEntry(id).provider;
  }

  /** Resolves a provider only when it is enabled, ready, and holds a usable server-side credential. */
  getConfiguredProvider(id: string): SmsProvider {
    const entry = this.getEntry(id);
    if (!entry.configuration.enabled) {
      throw new SmsProviderError('unavailable', id, 'The selected SMS provider is disabled', false, 422);
    }
    if (entry.lifecycle !== 'ready') {
      throw new SmsProviderError('unavailable', id, 'The selected SMS provider is not ready', true, 503);
    }
    if (!entry.provider.isConfigured()) {
      throw new SmsProviderError('unauthorized', id, 'The selected SMS provider has no configured credential', false, 503);
    }
    return entry.provider;
  }

  isEnabled(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.configuration.enabled === true && entry.lifecycle === 'ready';
  }

  isConfigured(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.configuration.enabled === true && entry.lifecycle === 'ready' && entry.provider.isConfigured();
  }

  getManifest(id: string): SmsProviderManifest | undefined {
    return this.entries.get(id)?.provider.manifest;
  }

  async health(id: string): Promise<SmsProviderHealth> {
    const entry = this.getEntry(id);
    try {
      return await entry.provider.health();
    } catch {
      return { status: 'unavailable', message: 'Provider health check failed' };
    }
  }

  async list(): Promise<SmsProviderSummary[]> {
    return Promise.all([...this.entries.values()].map(async (entry) => {
      let health: SmsProviderHealth;
      try {
        health = await entry.provider.health();
      } catch {
        health = { status: 'unavailable', message: 'Provider health check failed' };
      }
      const { manifest } = entry.provider;
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        kind: manifest.kind,
        status: entry.configuration.enabled ? 'enabled' : 'disabled',
        lifecycle: entry.lifecycle,
        configured: entry.provider.isConfigured(),
        capabilities: manifest.capabilities,
        health,
      };
    }));
  }

  private getEntry(id: string): SmsProviderEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new SmsProviderError('not_found', id, `SMS provider '${id}' is not installed`, false, 422);
    return entry;
  }

  private validateRegistration(provider: SmsProvider, configuration: SmsProviderConfiguration): void {
    const { manifest } = provider;
    if (!configuration || typeof configuration.enabled !== 'boolean' || !configuration.settings ||
        typeof configuration.settings !== 'object' || Array.isArray(configuration.settings)) {
      throw new Error('SMS provider configuration must define enabled and an object of settings');
    }
    const capabilities = manifest?.capabilities;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id) || manifest.id !== provider.id ||
        !manifest.name?.trim() || !manifest.version?.trim() || !manifest.description?.trim() ||
        !['http-sms'].includes(manifest.kind) || !capabilities ||
        ['sendSms', 'sendOtp', 'reportsSegments', 'reportsProviderCost', 'idempotentRetries']
          .some((key) => typeof capabilities[key as keyof typeof capabilities] !== 'boolean') ||
        !Number.isInteger(capabilities.maxMessageLength) ||
        capabilities.maxMessageLength < 1 || capabilities.maxMessageLength > 1600 ||
        (capabilities.sendSms && typeof provider.sendSms !== 'function') ||
        (capabilities.sendOtp && typeof provider.sendOtp !== 'function') ||
        typeof provider.isConfigured !== 'function' ||
        typeof provider.health !== 'function') {
      throw new Error('SMS provider manifest is invalid');
    }
  }
}
