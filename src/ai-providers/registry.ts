import { AiProviderError, type AiProvider, type AiProviderConfiguration, type AiProviderHealth, type AiProviderManifest } from '../ai-provider.js';

type AiProviderEntry = {
  provider: AiProvider;
  configuration: AiProviderConfiguration;
  lifecycle: 'registered' | 'ready' | 'failed' | 'stopped';
};

export type AiProviderSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: AiProviderManifest['kind'];
  status: 'enabled' | 'disabled';
  lifecycle: AiProviderEntry['lifecycle'];
  configured: boolean;
  capabilities: AiProviderManifest['capabilities'];
  health: AiProviderHealth;
};

export class AiProviderRegistry {
  private readonly entries = new Map<string, AiProviderEntry>();
  private initialized = false;

  register(provider: AiProvider, configuration: AiProviderConfiguration): void {
    if (this.initialized) throw new Error('AI provider registry is already initialized');
    this.validateRegistration(provider, configuration);
    if (this.entries.has(provider.id)) throw new Error(`AI provider '${provider.id}' is already registered`);
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

  getProvider(id: string): AiProvider {
    return this.getEntry(id).provider;
  }

  /** Resolves a provider only when it is enabled, ready, and holds a usable server-side credential. */
  getConfiguredProvider(id: string): AiProvider {
    const entry = this.getEntry(id);
    if (!entry.configuration.enabled) {
      throw new AiProviderError('unavailable', id, 'The selected AI provider is disabled', false, 422);
    }
    if (entry.lifecycle !== 'ready') {
      throw new AiProviderError('unavailable', id, 'The selected AI provider is not ready', true, 503);
    }
    if (!entry.provider.isConfigured()) {
      throw new AiProviderError('unauthorized', id, 'The selected AI provider has no configured credential', false, 503);
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

  getManifest(id: string): AiProviderManifest | undefined {
    return this.entries.get(id)?.provider.manifest;
  }

  async health(id: string): Promise<AiProviderHealth> {
    const entry = this.getEntry(id);
    try {
      return await entry.provider.health();
    } catch {
      return { status: 'unavailable', message: 'Provider health check failed' };
    }
  }

  async list(): Promise<AiProviderSummary[]> {
    return Promise.all([...this.entries.values()].map(async (entry) => {
      let health: AiProviderHealth;
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

  private getEntry(id: string): AiProviderEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new AiProviderError('not_found', id, `AI provider '${id}' is not installed`, false, 422);
    return entry;
  }

  private validateRegistration(provider: AiProvider, configuration: AiProviderConfiguration): void {
    const { manifest } = provider;
    if (!configuration || typeof configuration.enabled !== 'boolean' || !configuration.settings ||
        typeof configuration.settings !== 'object' || Array.isArray(configuration.settings)) {
      throw new Error('AI provider configuration must define enabled and an object of settings');
    }
    const capabilities = manifest?.capabilities;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id) || manifest.id !== provider.id ||
        !manifest.name?.trim() || !manifest.version?.trim() || !manifest.description?.trim() ||
        !['openai-compatible'].includes(manifest.kind) || !capabilities ||
        ['chatCompletions', 'streaming', 'toolCalls', 'systemPrompts', 'reportsInputTokens', 'reportsOutputTokens']
          .some((key) => typeof capabilities[key as keyof typeof capabilities] !== 'boolean') ||
        !Number.isInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens < 1 ||
        typeof provider.isConfigured !== 'function' ||
        typeof provider.createChatCompletion !== 'function' ||
        typeof provider.listModels !== 'function') {
      throw new Error('AI provider manifest is invalid');
    }
  }
}
