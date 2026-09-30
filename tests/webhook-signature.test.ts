import { describe, expect, it } from 'vitest';
import { createWebhookSignature, verifyWebhookSignature } from '../src/webhooks/signature.js';

describe('Tariffia webhook signatures', () => {
  const secret = 'merchant-webhook-secret-with-more-than-32-bytes';
  const rawBody = '{"id":"event-1","type":"payment.confirmed"}';
  const timestamp = 1_800_000_000;

  it('verifies the timestamped HMAC signature over the exact raw body', () => {
    const signed = createWebhookSignature(secret, rawBody, timestamp);
    expect(signed.header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({
      secret, rawBody, signatureHeader: signed.header, timestampHeader: String(timestamp), nowSeconds: timestamp + 30,
    })).toEqual({ valid: true });
  });

  it('rejects altered bodies and timestamps outside tolerance', () => {
    const signed = createWebhookSignature(secret, rawBody, timestamp);
    expect(verifyWebhookSignature({
      secret, rawBody: `${rawBody} `, signatureHeader: signed.header, nowSeconds: timestamp,
    }).valid).toBe(false);
    expect(verifyWebhookSignature({
      secret, rawBody, signatureHeader: signed.header, nowSeconds: timestamp + 301,
    })).toMatchObject({ valid: false, reason: expect.stringContaining('timestamp') });
    expect(verifyWebhookSignature({
      secret, rawBody, signatureHeader: signed.header, timestampHeader: String(timestamp + 1), nowSeconds: timestamp,
    })).toMatchObject({ valid: false, reason: expect.stringContaining('does not match') });
  });
});
