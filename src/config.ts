import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1).default('postgres://tariffia:tariffia@localhost:5432/tariffia'),
  ADMIN_API_KEY: z.string().min(24).default('dev-admin-key-change-this-before-deploy'),
  API_KEY_PEPPER: z.string().min(24).default('dev-pepper-change-this-before-deploy'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  USDC_TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0x833589fCD6eDb6E08f4c7C32d4F71b54bdA02913'),
  USDC_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
  PAYMENT_DETECTOR_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  PAYMENT_SCAN_LOOKBACK_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(100),
  PAYMENT_SCAN_BLOCK_RANGE: z.coerce.number().int().min(1).max(5_000).default(500),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = parsed.data;

if (config.NODE_ENV === 'production' &&
    (config.ADMIN_API_KEY.startsWith('dev-') || config.API_KEY_PEPPER.startsWith('dev-') ||
      config.ADMIN_API_KEY.startsWith('replace-with-') || config.API_KEY_PEPPER.startsWith('replace-with-'))) {
  throw new Error('ADMIN_API_KEY and API_KEY_PEPPER must be changed in production');
}
