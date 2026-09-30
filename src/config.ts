import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1).default('postgres://tariffia:tariffia@localhost:5432/tariffia'),
  ADMIN_API_KEY: z.string().min(24).default('dev-admin-key-change-this-before-deploy'),
  API_KEY_PEPPER: z.string().min(24).default('dev-pepper-change-this-before-deploy'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
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
