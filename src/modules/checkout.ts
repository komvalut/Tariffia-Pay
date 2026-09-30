import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { checkoutUrlForPayment } from '../checkout-links.js';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { verifyPaymentSchema } from '../schemas.js';
import { parseBody } from '../http.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';
import type { PaymentVerificationService } from '../services/payment-verification-service.js';

type PublicPayment = {
  id: string;
  order_id: string;
  order_reference: string | null;
  description: string;
  merchant_name: string;
  amount: string;
  amount_base_units: string;
  currency: string;
  adapter: string;
  network: string;
  recipient_address: string;
  token_address: string | null;
  tx_hash: string | null;
  status: string;
  order_status: string;
  expires_at: Date | null;
};

const publicIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checkoutHtml = readFile(new URL('../../web/checkout.html', import.meta.url), 'utf8');

export function checkoutQrContent(
  paymentId: string,
  adapterId: string,
  recipientAddress: string,
  adapters: PaymentAdapterRegistry,
): string {
  return adapters.getManifest(adapterId)?.capabilities.paymentRequestFormat === 'invoice'
    ? recipientAddress
    : checkoutUrlForPayment(paymentId);
}

export const checkoutRoutes: FastifyPluginAsync<{
  db: Database;
  verification: PaymentVerificationService;
  adapters: PaymentAdapterRegistry;
}> = async (app, { db, verification, adapters }) => {
  app.get('/p/:paymentId', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { paymentId } = request.params as { paymentId: string };
    if (!publicIdPattern.test(paymentId)) throw new HttpError(404, 'Payment link not found', 'not_found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await checkoutHtml);
  });

  app.get('/p/:paymentId/qr.png', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { paymentId } = request.params as { paymentId: string };
    if (!publicIdPattern.test(paymentId)) throw new HttpError(404, 'Payment link not found', 'not_found');
    const exists = await db.query<{ adapter: string; recipient_address: string }>(
      'SELECT adapter, recipient_address FROM payments WHERE id = $1', [paymentId],
    );
    const payment = exists.rows[0];
    if (!payment) throw new HttpError(404, 'Payment link not found', 'not_found');
    const qrContent = checkoutQrContent(paymentId, payment.adapter, payment.recipient_address, adapters);
    const image = await QRCode.toBuffer(qrContent, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 360 });
    return reply.type('image/png').header('cache-control', 'public, max-age=300').send(image);
  });

  app.get('/v1/public/payment-methods', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
    return reply.send({ methods: await adapters.availableForCheckout() });
  });

  app.get('/v1/public/payments/:paymentId', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { paymentId } = request.params as { paymentId: string };
    if (!publicIdPattern.test(paymentId)) throw new HttpError(404, 'Payment link not found', 'not_found');
    await verification.pollPublic(paymentId);
    const result = await db.query<PublicPayment>(
      `SELECT p.id, o.id AS order_id, o.reference AS order_reference, o.description, m.name AS merchant_name,
              p.amount::text AS amount, p.adapter,
              p.amount_base_units::text AS amount_base_units, p.currency, p.network,
              p.recipient_address, p.token_address, p.tx_hash, p.status, o.status AS order_status, p.expires_at
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN merchants m ON m.id = p.merchant_id
        WHERE p.id = $1`,
      [paymentId],
    );
    const payment = result.rows[0];
    if (!payment) throw new HttpError(404, 'Payment link not found', 'not_found');
    const manifest = adapters.getManifest(payment.adapter);
    const paymentRequestFormat = manifest?.capabilities.paymentRequestFormat ?? 'wallet';
    return reply.send({
      payment: {
        id: payment.id,
        orderId: payment.order_reference || payment.order_id.slice(0, 8),
        merchant: payment.merchant_name,
        description: payment.description,
        amount: payment.amount,
        amountBaseUnits: payment.amount_base_units,
        currency: payment.currency,
        network: payment.network,
        adapter: payment.adapter,
        paymentMethod: {
          id: payment.adapter,
          name: manifest?.name ?? payment.adapter,
          paymentRequestFormat,
        },
        paymentRequest: paymentRequestFormat === 'invoice' ? payment.recipient_address : null,
        chainId: payment.network === 'base' ? 8453 : null,
        recipientAddress: payment.recipient_address,
        tokenAddress: payment.token_address,
        txHash: payment.tx_hash,
        transactionId: payment.tx_hash,
        status: payment.status,
        orderStatus: payment.order_status,
        expiresAt: payment.expires_at,
      },
    });
  });

  app.post('/v1/public/payments/:paymentId/verify', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { paymentId } = request.params as { paymentId: string };
    if (!publicIdPattern.test(paymentId)) throw new HttpError(404, 'Payment link not found', 'not_found');
    const body = parseBody(verifyPaymentSchema, request.body);
    const result = await verification.processPublic(paymentId, body.transactionId ?? body.transactionHash!);
    return reply.code(['CONFIRMED', 'FAILED'].includes(result.status) ? 200 : 202).send({ payment: result });
  });
};
