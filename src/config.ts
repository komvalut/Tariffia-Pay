import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1).default('postgres://tariffia:tariffia@localhost:5432/tariffia'),
  TRUST_PROXY: z.string().default('false'),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
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
  PAYMENT_EXPIRATION_MINUTES: z.coerce.number().int().min(1).max(10_080).default(60),
  USDC_ADAPTER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  WEBHOOK_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).default('0'.repeat(64)),
  WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(3000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  WEBHOOK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  CREDITS_PER_USDC_RATE: z.coerce.number().int().min(1).max(1_000_000).default(100),
  CREDIT_MINIMUM_TOPUP_USDC: z.string().regex(/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/).default('1.000000'),
  CREDIT_MAXIMUM_TOPUP_USDC: z.string().regex(/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/).default('1000.000000'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = parsed.data;

export type AppConfig = typeof config;

export function validateProductionConfiguration(
  values: AppConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (values.NODE_ENV !== 'production') return;

  const required = ['DATABASE_URL', 'ADMIN_API_KEY', 'API_KEY_PEPPER', 'PUBLIC_BASE_URL', 'WEBHOOK_ENCRYPTION_KEY'];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`Production configuration requires explicit values for: ${missing.join(', ')}`);

  let databaseUrl: URL;
  let databasePassword: string;
  try {
    databaseUrl = new URL(values.DATABASE_URL);
    databasePassword = decodeURIComponent(databaseUrl.password);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL in production');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
      values.DATABASE_URL === 'postgres://tariffia:tariffia@localhost:5432/tariffia' ||
      (databasePassword.length > 0 && (databasePassword.length < 24 || /^(replace-with-|change-me|password|tariffia)/i.test(databasePassword)))) {
    throw new Error('DATABASE_URL must not use a development or placeholder configuration in production');
  }

  const secrets = [values.ADMIN_API_KEY, values.API_KEY_PEPPER];
  if (secrets.some((secret) => secret.length < 32 || /^(.)\1+$/.test(secret) || /^(dev-|replace-with-|change-me|password)/i.test(secret))) {
    throw new Error('ADMIN_API_KEY and API_KEY_PEPPER must be distinct, non-placeholder secrets of at least 32 characters in production');
  }
  if (/^0{64}$/i.test(values.WEBHOOK_ENCRYPTION_KEY) || /^(.)\1+$/.test(values.WEBHOOK_ENCRYPTION_KEY)) {
    throw new Error('WEBHOOK_ENCRYPTION_KEY must be a random 32-byte key in production');
  }
  const configuredSecrets = [values.ADMIN_API_KEY, values.API_KEY_PEPPER, values.WEBHOOK_ENCRYPTION_KEY.toLowerCase()];
  if (databasePassword) configuredSecrets.push(databasePassword);
  if (new Set(configuredSecrets.map((secret) => secret.toLowerCase())).size !== configuredSecrets.length) {
    throw new Error('Database, admin, API pepper, and webhook encryption secrets must not be reused in production');
  }
  const publicUrl = new URL(values.PUBLIC_BASE_URL);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment in production');
  }
  if (new URL(values.BASE_RPC_URL).protocol !== 'https:') {
    throw new Error('BASE_RPC_URL must use HTTPS in production');
  }
  const trustProxy = values.TRUST_PROXY.trim().toLowerCase();
  const proxyRanges = trustProxy.split(',').map((item) => item.trim());
  if (trustProxy === 'true' || proxyRanges.some((range) => ['*', '0.0.0.0/0', '::/0'].includes(range))) {
    throw new Error('TRUST_PROXY must name constrained proxy IPs/CIDRs rather than trust every forwarded address');
  }
}

validateProductionConfiguration(config);
