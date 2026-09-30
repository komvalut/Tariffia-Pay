import { describe, expect, it } from 'vitest';
import { safeErrorMetadata } from '../src/safe-logging.js';
import { safeWebhookTransportError, sanitizeStoredWebhookError } from '../src/webhooks/error-safety.js';

describe('safe error logging', () => {
  it('keeps secrets and arbitrary error messages/stacks out of structured logs', () => {
    const error = Object.assign(new Error('RPC URL contains api-key=secret-value'), { code: 'ECONNRESET' });
    expect(safeErrorMetadata(error)).toEqual({ errorName: 'Error', errorCode: 'ECONNRESET' });
    expect(JSON.stringify(safeErrorMetadata(error))).not.toContain('secret-value');
  });

  it('omits unbounded or nonstandard error metadata', () => {
    const error = Object.assign(new Error('private'), { name: 'key=value', code: 'secret api key' });
    expect(safeErrorMetadata(error)).toEqual({ errorName: 'UnknownError' });
  });

  it('does not persist or return raw webhook destination errors that may contain URL credentials', () => {
    const secretUrl = 'https://hooks.example/events?token=webhook-url-secret';
    expect(safeWebhookTransportError(new Error(secretUrl))).toBe('Webhook transport failed (Error)');
    expect(sanitizeStoredWebhookError(secretUrl, null)).toBe('Webhook delivery failed before an HTTP response');
    expect(sanitizeStoredWebhookError(secretUrl, 503)).toBe('Webhook receiver returned HTTP 503');
  });
});
