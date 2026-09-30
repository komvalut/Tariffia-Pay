import { describe, expect, it } from 'vitest';
import { pinnedWebhookConnection } from '../src/webhooks/pinned-request.js';
import { isPublicAddress, resolveWebhookTarget } from '../src/webhooks/url.js';

describe('production webhook destination validation', () => {
  it('pins the validated DNS answer for the socket while preserving Host and TLS SNI', async () => {
    let lookups = 0;
    const target = await resolveWebhookTarget('https://hooks.example.test/events', {
      production: true,
      lookupHost: async () => {
        lookups++;
        return [{ address: '8.8.8.8', family: 4 }];
      },
    });

    const connection = pinnedWebhookConnection(target);
    expect(lookups).toBe(1);
    expect(connection.url.hostname).toBe('8.8.8.8');
    expect(connection.url.pathname).toBe('/events');
    expect(connection.hostHeader).toBe('hooks.example.test');
    expect(connection.servername).toBe('hooks.example.test');
  });

  it('rejects DNS answers containing any private or reserved address', async () => {
    await expect(resolveWebhookTarget('https://hooks.example.test/events', {
      production: true,
      lookupHost: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })).rejects.toMatchObject({ statusCode: 400, code: 'invalid_webhook_url' });
  });

  it('rejects public HTTP destinations and private literal IPs in production mode', async () => {
    await expect(resolveWebhookTarget('http://hooks.example.test/events', { production: true }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_webhook_url' });
    await expect(resolveWebhookTarget('https://10.0.0.9/events', { production: true }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_webhook_url' });
  });

  it('rejects IPv6 special-use and transition addresses while allowing global unicast', () => {
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicAddress('2001:4860:ffff:c0a8:0101:0:0:1')).toBe(true);
    for (const address of ['4000::1', '2001:db8::1', '2002:c0a8:1::1', '3fff::1', '::ffff:192.168.1.1', '::ffff:c0a8:0101', '192.88.99.1']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('uses the one public DNS answer validated for the outbound socket instead of resolving again', async () => {
    let lookups = 0;
    const target = await resolveWebhookTarget('https://hooks.example.test/events', {
      production: true,
      lookupHost: async () => {
        lookups++;
        return lookups === 1
          ? [{ address: '8.8.8.8', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const connection = pinnedWebhookConnection(target);
    expect(connection.url.hostname).toBe('8.8.8.8');
    expect(connection.hostHeader).toBe('hooks.example.test');
    expect(connection.servername).toBe('hooks.example.test');
    expect(lookups).toBe(1);
  });
});
