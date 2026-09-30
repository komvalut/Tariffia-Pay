import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookSignature = {
  timestamp: number;
  header: string;
};

export function createWebhookSignature(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): WebhookSignature {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return { timestamp, header: `t=${timestamp},v1=${digest}` };
}

export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string;
  timestampHeader?: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): { valid: boolean; reason?: string } {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/i.exec(input.signatureHeader.trim());
  if (!match) return { valid: false, reason: 'Malformed Tariffia signature header' };
  const timestamp = Number(match[1]);
  if (input.timestampHeader !== undefined && Number(input.timestampHeader) !== timestamp) {
    return { valid: false, reason: 'Webhook timestamp header does not match signed timestamp' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'Webhook timestamp is outside the allowed tolerance' };
  }
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.rawBody}`, 'utf8').digest();
  const received = Buffer.from(match[2]!, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { valid: false, reason: 'Webhook signature does not match' };
  }
  return { valid: true };
}
