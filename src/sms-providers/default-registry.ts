import { SmsProviderRegistry } from './registry.js';
import { createHttpSmsProvider, httpSmsProviderSettings } from './http-sms-provider.js';
import { createTextBeeSmsProvider, textBeeProviderSettings } from './textbee-sms-provider.js';
import { config } from '../config.js';

/**
 * Builds the process-wide SMS provider registry. Credentials come from the environment only,
 * so no provider secret is ever read from or written to the database. The generic HTTP SMS
 * provider is registered by default; the TextBee provider is registered only when explicitly
 * enabled, and both can serve different services as primary and fallback.
 */
export function createDefaultSmsProviderRegistry(): SmsProviderRegistry {
  const registry = new SmsProviderRegistry();
  registry.register(createHttpSmsProvider(), {
    enabled: config.SMS_PROVIDER_ENABLED,
    settings: httpSmsProviderSettings(),
  });
  if (config.TEXTBEE_ENABLED) {
    registry.register(createTextBeeSmsProvider(), {
      enabled: true,
      settings: textBeeProviderSettings(),
    });
  }
  return registry;
}
