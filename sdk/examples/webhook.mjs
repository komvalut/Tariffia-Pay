import { createServer } from 'node:http';
import { verifyWebhookSignature } from '@tariffia/pay/server';

const secret = process.env.TARIFFIA_WEBHOOK_SECRET;
if (!secret) throw new Error('Set TARIFFIA_WEBHOOK_SECRET on the webhook server');

// Replace this in-memory example with durable event-ID storage for production.
const handledEventIds = new Set();

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/hooks/tariffia') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  const signature = request.headers['x-tariffia-signature'];
  const timestamp = request.headers['x-tariffia-timestamp'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    response.writeHead(400).end('Missing signature headers');
    return;
  }

  const verification = verifyWebhookSignature({
    secret,
    rawBody,
    signatureHeader: signature,
    timestampHeader: timestamp,
    toleranceSeconds: 300,
  });
  if (!verification.valid) {
    response.writeHead(401).end(verification.reason);
    return;
  }

  const event = JSON.parse(rawBody);
  if (handledEventIds.has(event.id)) {
    response.writeHead(200).end('Already handled');
    return;
  }
  handledEventIds.add(event.id);
  console.log('Verified Tariffia event:', event.type, event.id);
  response.writeHead(200).end('OK');
});

server.listen(Number(process.env.PORT ?? 9090), '0.0.0.0', () => {
  console.log(`Webhook example listening on ${process.env.PORT ?? 9090}`);
});
