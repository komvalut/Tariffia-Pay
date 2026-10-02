import { describe, expect, it } from 'vitest';
import { config, validateProductionConfiguration } from '../src/config.js';

const aiApiKey = 'sk-live-0123456789abcdefghijklmnopqrstuvwxyz';
const smsApiKey = 'sms-live-0123456789abcdefghijklmnopqrstuvwxyz';
const textbeeApiKey = 'textbee-live-0123456789abcdefghijklmnop';
const smsBaseUrl = 'https://sms-gateway.example';

const productionValues = {
  ...config,
  NODE_ENV: 'production' as const,
  DATABASE_URL: 'postgres://tariffia:long-production-database-password-123@db.example:5432/tariffia',
  ADMIN_API_KEY: 'admin-secret-with-at-least-thirty-two-characters',
  API_KEY_PEPPER: 'different-pepper-with-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'https://pay.example.com',
  WEBHOOK_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  OPENAI_API_KEY: aiApiKey,
  SMS_HTTP_API_KEY: smsApiKey,
  SMS_HTTP_BASE_URL: smsBaseUrl,
  TEXTBEE_API_KEY: textbeeApiKey,
};

const productionEnvironment = {
  DATABASE_URL: productionValues.DATABASE_URL,
  ADMIN_API_KEY: productionValues.ADMIN_API_KEY,
  API_KEY_PEPPER: productionValues.API_KEY_PEPPER,
  PUBLIC_BASE_URL: productionValues.PUBLIC_BASE_URL,
  WEBHOOK_ENCRYPTION_KEY: productionValues.WEBHOOK_ENCRYPTION_KEY,
  OPENAI_API_KEY: aiApiKey,
  SMS_HTTP_API_KEY: smsApiKey,
  SMS_HTTP_BASE_URL: smsBaseUrl,
  TEXTBEE_API_KEY: textbeeApiKey,
};

describe('production security configuration', () => {
  it('accepts explicit HTTPS and distinct production secrets', () => {
    expect(() => validateProductionConfiguration(productionValues, productionEnvironment)).not.toThrow();
  });

  it('rejects implicit default and placeholder database and secret configuration', () => {
    const { DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = productionEnvironment;
    expect(() => validateProductionConfiguration(productionValues, missingDatabaseUrl)).toThrow(/DATABASE_URL/);
    expect(() => validateProductionConfiguration({ ...productionValues, DATABASE_URL: 'postgres://tariffia:replace-with-a-long-random-database-password@db.example/tariffia' }, productionEnvironment))
      .toThrow(/development or placeholder/);
    expect(() => validateProductionConfiguration({ ...productionValues, DATABASE_URL: 'postgres://tariffia:tariffia@localhost:5432/tariffia' }, productionEnvironment))
      .toThrow(/development or placeholder/);
    const { WEBHOOK_ENCRYPTION_KEY: _encryptionKey, ...missingEncryptionKey } = productionEnvironment;
    expect(() => validateProductionConfiguration(productionValues, missingEncryptionKey)).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
  });

  it('rejects HTTP public/RPC origins, short/reused secrets, and blanket proxy trust', () => {
    expect(() => validateProductionConfiguration({ ...productionValues, PUBLIC_BASE_URL: 'http://pay.example.com' }, productionEnvironment))
      .toThrow(/HTTPS origin/);
    expect(() => validateProductionConfiguration({ ...productionValues, PUBLIC_BASE_URL: 'https://merchant:secret@pay.example.com' }, productionEnvironment))
      .toThrow(/credentials/);
    expect(() => validateProductionConfiguration({ ...productionValues, BASE_RPC_URL: 'http://rpc.example.com' }, productionEnvironment))
      .toThrow(/BASE_RPC_URL.*HTTPS/);
    expect(() => validateProductionConfiguration({ ...productionValues, ADMIN_API_KEY: 'short-secret' }, productionEnvironment))
      .toThrow(/32 characters/);
    expect(() => validateProductionConfiguration({ ...productionValues, API_KEY_PEPPER: productionValues.ADMIN_API_KEY }, productionEnvironment))
      .toThrow(/secrets must not be reused/);
    expect(() => validateProductionConfiguration({ ...productionValues, TRUST_PROXY: 'true' }, productionEnvironment))
      .toThrow(/TRUST_PROXY.*trust every forwarded address/);
    expect(() => validateProductionConfiguration({ ...productionValues, TRUST_PROXY: '0.0.0.0/0' }, productionEnvironment))
      .toThrow(/trust every forwarded address/);
  });

  it('requires an explicit AI provider credential and a safe provider origin in production', () => {
    const { OPENAI_API_KEY: _apiKey, ...missingApiKey } = productionEnvironment;
    expect(() => validateProductionConfiguration(productionValues, missingApiKey))
      .toThrow(/OPENAI_API_KEY to be configured explicitly/);
    expect(() => validateProductionConfiguration({ ...productionValues, OPENAI_BASE_URL: 'http://api.openai.com/v1' }, productionEnvironment))
      .toThrow(/OPENAI_BASE_URL.*HTTPS/);
    expect(() => validateProductionConfiguration({ ...productionValues, OPENAI_BASE_URL: 'https://user:secret@api.openai.com/v1' }, productionEnvironment))
      .toThrow(/must not contain credentials/);
    expect(() => validateProductionConfiguration(
      { ...productionValues, OPENAI_API_KEY: 'replace-with-provider-key' },
      { ...productionEnvironment, OPENAI_API_KEY: 'replace-with-provider-key' },
    )).toThrow(/real provider credential/);
    // Disabling the provider removes the requirement entirely.
    expect(() => validateProductionConfiguration(
      { ...productionValues, OPENAI_API_ENABLED: false, OPENAI_API_KEY: '' },
      { ...productionEnvironment, OPENAI_API_KEY: '' },
    )).not.toThrow();
  });

  it('requires an explicit SMS provider credential and a safe provider origin in production', () => {
    expect(() => validateProductionConfiguration(
      { ...productionValues, SMS_HTTP_BASE_URL: '' },
      { ...productionEnvironment, SMS_HTTP_BASE_URL: '' },
    )).toThrow(/SMS_HTTP_BASE_URL to be configured explicitly/);
    expect(() => validateProductionConfiguration(
      { ...productionValues, SMS_HTTP_BASE_URL: 'http://sms-gateway.example' },
      { ...productionEnvironment, SMS_HTTP_BASE_URL: 'http://sms-gateway.example' },
    )).toThrow(/SMS_HTTP_BASE_URL.*HTTPS/);
    expect(() => validateProductionConfiguration(
      { ...productionValues, SMS_HTTP_BASE_URL: 'https://user:secret@sms-gateway.example' },
      { ...productionEnvironment, SMS_HTTP_BASE_URL: 'https://user:secret@sms-gateway.example' },
    )).toThrow(/must not contain credentials/);
    const { SMS_HTTP_API_KEY: _smsKey, ...missingSmsKey } = productionEnvironment;
    expect(() => validateProductionConfiguration(productionValues, missingSmsKey))
      .toThrow(/SMS_HTTP_API_KEY to be configured explicitly/);
    expect(() => validateProductionConfiguration(
      { ...productionValues, SMS_HTTP_API_KEY: 'replace-with-provider-key' },
      { ...productionEnvironment, SMS_HTTP_API_KEY: 'replace-with-provider-key' },
    )).toThrow(/real provider credential/);
    expect(() => validateProductionConfiguration(
      { ...productionValues, SMS_HTTP_SEND_PATH: 'v1/messages' },
      { ...productionEnvironment, SMS_HTTP_SEND_PATH: 'v1/messages' },
    )).toThrow(/relative paths/);
    expect(() => validateProductionConfiguration(
      { ...productionValues, SMS_PROVIDER_ENABLED: false, SMS_HTTP_API_KEY: '', SMS_HTTP_BASE_URL: '' },
      { ...productionEnvironment, SMS_HTTP_API_KEY: '', SMS_HTTP_BASE_URL: '' },
    )).not.toThrow();
  });

  it('requires an explicit TextBee credential and a safe origin when TextBee is enabled', () => {
    const enabled = { ...productionValues, TEXTBEE_ENABLED: true } as typeof productionValues;
    const enabledEnvironment = { ...productionEnvironment, TEXTBEE_ENABLED: 'true' };
    expect(() => validateProductionConfiguration(
      { ...enabled, TEXTBEE_API_KEY: '' },
      { ...enabledEnvironment, TEXTBEE_API_KEY: '' },
    )).toThrow(/TEXTBEE_API_KEY to be configured explicitly/);
    expect(() => validateProductionConfiguration(
      { ...enabled, TEXTBEE_BASE_URL: 'http://api.textbee.dev/api/v1' },
      { ...enabledEnvironment, TEXTBEE_BASE_URL: 'http://api.textbee.dev/api/v1' },
    )).toThrow(/TEXTBEE_BASE_URL.*HTTPS/);
    expect(() => validateProductionConfiguration(
      { ...enabled, TEXTBEE_BASE_URL: 'https://user:secret@api.textbee.dev/api/v1' },
      { ...enabledEnvironment, TEXTBEE_BASE_URL: 'https://user:secret@api.textbee.dev/api/v1' },
    )).toThrow(/must not contain credentials/);
    expect(() => validateProductionConfiguration(
      { ...enabled, TEXTBEE_API_KEY: 'replace-with-textbee-key' },
      { ...enabledEnvironment, TEXTBEE_API_KEY: 'replace-with-textbee-key' },
    )).toThrow(/real provider credential/);
    expect(() => validateProductionConfiguration(enabled, enabledEnvironment)).not.toThrow();
    // Disabled by default: no TextBee configuration is required.
    expect(() => validateProductionConfiguration(productionValues, productionEnvironment)).not.toThrow();
  });

  it('rejects reusing a database password as an application secret', () => {
    const reused = 'same-secret-value-that-is-longer-than-32-characters';
    const values = {
      ...productionValues,
      DATABASE_URL: `postgres://tariffia:${reused}@db.example:5432/tariffia`,
      ADMIN_API_KEY: reused,
    };
    const environment = { ...productionEnvironment, DATABASE_URL: values.DATABASE_URL, ADMIN_API_KEY: reused };
    expect(() => validateProductionConfiguration(values, environment)).toThrow(/must not be reused/);
  });
});
