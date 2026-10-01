import { SmsProviderRegistry } from './registry.js';
import { createHttpSmsProvider, httpSmsProviderSettings } from './http-sms-provider.js';
import { config } from '../config.js';

/**
 * Builds the process-wide SMS provider registry. Credentials come from the environment only,
 * so no provider secret is ever read from or written to the database.
 */
export function createDefaultSmsProviderRegistry(): SmsProviderRegistry {
  const registry = new SmsProviderRegistry();
  registry.register(createHttpSmsProvider(), {
    enabled: config.SMS_PROVIDER_ENABLED,
    settings: httpSmsProviderSettings(),
  });
  return registry;
}
