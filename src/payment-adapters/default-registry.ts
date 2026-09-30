import { BaseUsdcAdapter, baseUsdcAdapterSettings } from '../adapters/usdc/base-usdc-adapter.js';
import { lightningAdapterSettings, LightningAdapter } from '../adapters/lightning-adapter.js';
import { config } from '../config.js';
import { PaymentAdapterRegistry } from './registry.js';

export function createDefaultPaymentAdapterRegistry(): PaymentAdapterRegistry {
  const registry = new PaymentAdapterRegistry();
  registry.register(new BaseUsdcAdapter(), {
    enabled: config.USDC_ADAPTER_ENABLED,
    settings: baseUsdcAdapterSettings(),
    isDefault: true,
  });
  registry.register(new LightningAdapter(), {
    enabled: config.LIGHTNING_ADAPTER_ENABLED,
    settings: lightningAdapterSettings(),
  });
  return registry;
}
