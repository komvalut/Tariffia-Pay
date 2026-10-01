import { AiProviderRegistry } from './registry.js';
import { createDefaultAiProvider, defaultAiProviderSettings } from './openai-provider.js';
import { config } from '../config.js';

/**
 * Builds the process-wide AI provider registry. Credentials come from the environment only,
 * so no provider secret is ever read from or written to the database.
 */
export function createDefaultAiProviderRegistry(): AiProviderRegistry {
  const registry = new AiProviderRegistry();
  registry.register(createDefaultAiProvider(), {
    enabled: config.OPENAI_API_ENABLED,
    settings: defaultAiProviderSettings(),
  });
  return registry;
}
