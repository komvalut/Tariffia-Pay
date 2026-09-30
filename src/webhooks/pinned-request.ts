import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, type WebhookTarget } from './url.js';

export interface PinnedWebhookRequest {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface PinnedWebhookResponse {
  status: number;
  ok: boolean;
}

export function pinnedWebhookConnection(target: WebhookTarget): {
  url: URL;
  hostHeader: string;
  servername?: string;
} {
  if (!target.addresses?.length || target.addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook target has no validated public address');
  }
  const address = target.addresses[0]!;
  const url = new URL(target.url);
  url.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const originalHostname = target.url.hostname.replace(/^\[|\]$/g, '');
  return {
    url,
    hostHeader: target.url.host,
    ...(isIP(originalHostname) ? {} : { servername: originalHostname }),
  };
}

/** Connect to an already validated address while retaining the configured host for Host and TLS SNI. */
export async function sendWebhookPinned(target: WebhookTarget, input: PinnedWebhookRequest): Promise<PinnedWebhookResponse> {
  const connection = pinnedWebhookConnection(target);
  const headers = {
    ...input.headers,
    host: connection.hostHeader,
    'content-length': String(Buffer.byteLength(input.body, 'utf8')),
  };

  return new Promise((resolve, reject) => {
    const onResponse = (response: http.IncomingMessage) => {
      const status = response.statusCode ?? 0;
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Webhook receiver closed the response early')));
      response.on('end', () => resolve({ status, ok: status >= 200 && status < 300 }));
      response.resume();
    };
    const commonOptions = {
      method: 'POST',
      headers,
      signal: input.signal,
    };
    const request = target.url.protocol === 'https:'
      ? https.request(connection.url, { ...commonOptions, ...(connection.servername ? { servername: connection.servername } : {}) }, onResponse)
      : target.url.protocol === 'http:'
        ? http.request(connection.url, commonOptions, onResponse)
        : null;
    if (!request) {
      reject(new Error('Webhook URL protocol is not HTTP(S)'));
      return;
    }
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error('Webhook request timed out')));
    request.on('error', reject);
    request.end(input.body);
  });
}
