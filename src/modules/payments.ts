import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { verifyPaymentSchema } from '../schemas.js';
import { getPaymentInvoice, merchantInvoiceView } from './billing-documents.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';
import type { PaymentVerificationService } from '../services/payment-verification-service.js';

export const paymentRoutes: FastifyPluginAsync<{
  db: Database; verification: PaymentVerificationService; adapters: PaymentAdapterRegistry;
}> = async (app, { db, verification, adapters }) => {
  app.get('/v1/payments/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const result = await db.query(
      `SELECT id, order_id AS "orderId", amount::text AS amount, amount_base_units::text AS "amountBaseUnits",
              currency, adapter, network, recipient_address AS "recipientAddress", token_address AS "tokenAddress", status,
              tx_hash AS "txHash", tx_hash AS "transactionId", expires_at AS "expiresAt", detected_at AS "detectedAt",
              confirmed_at AS "confirmedAt", created_at AS "createdAt"
         FROM payments WHERE id = $1 AND merchant_id = $2`,
      [paymentId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Payment not found', 'not_found');
    return reply.send({ payment: result.rows[0] });
  });

  // Payment details connect existing payment/order data with the existing invoice/receipt system.
  app.get('/v1/payments/:paymentId/details', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const result = await db.query<{
      id: string; orderId: string; amount: string; amountBaseUnits: string; currency: string; adapter: string;
      network: string; recipientAddress: string; tokenAddress: string | null; status: string; txHash: string | null;
      transactionId: string | null; expiresAt: Date | null; detectedAt: Date | null; confirmedAt: Date | null;
      createdAt: Date; orderReference: string | null; description: string; orderStatus: string; orderAmount: string;
      orderCurrency: string; customerId: string | null; orderCreatedAt: Date; orderUpdatedAt: Date;
    }>(
      `SELECT p.id, p.order_id AS "orderId", p.amount::text AS amount, p.amount_base_units::text AS "amountBaseUnits",
              p.currency, p.adapter, p.network, p.recipient_address AS "recipientAddress", p.token_address AS "tokenAddress",
              p.status, p.tx_hash AS "txHash", p.tx_hash AS "transactionId", p.expires_at AS "expiresAt",
              p.detected_at AS "detectedAt", p.confirmed_at AS "confirmedAt", p.created_at AS "createdAt",
              o.reference AS "orderReference", o.description, o.status AS "orderStatus", o.amount::text AS "orderAmount",
              o.currency AS "orderCurrency", o.customer_id AS "customerId",
              o.created_at AS "orderCreatedAt", o.updated_at AS "orderUpdatedAt"
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.id = $1 AND p.merchant_id = $2`,
      [paymentId, merchant.id],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'Payment not found', 'not_found');
    const invoiceRow = await getPaymentInvoice(db, merchant.id, paymentId);
    const invoice = invoiceRow ? merchantInvoiceView(invoiceRow, adapters) : null;
    return reply.send({
      payment: {
        id: row.id,
        orderId: row.orderId,
        amount: row.amount,
        amountBaseUnits: row.amountBaseUnits,
        currency: row.currency,
        status: row.status,
        paymentMethod: { id: row.adapter, name: adapters.getManifest(row.adapter)?.name ?? row.adapter },
        network: row.network,
        recipientAddress: row.recipientAddress,
        tokenAddress: row.tokenAddress,
        transactionId: row.transactionId,
        transactionHash: row.txHash,
        detectedAt: row.detectedAt,
        confirmedAt: row.confirmedAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      },
      order: {
        id: row.orderId,
        reference: row.orderReference,
        description: row.description,
        amount: row.orderAmount,
        currency: row.orderCurrency,
        status: row.orderStatus,
        customerId: row.customerId,
        createdAt: row.orderCreatedAt,
        updatedAt: row.orderUpdatedAt,
      },
      invoice,
      receipt: invoice?.receipt ?? null,
    });
  });

  app.post('/v1/payments/:paymentId/verify', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const body = parseBody(verifyPaymentSchema, request.body);
    const result = await verification.process(paymentId, merchant.id, body.transactionId ?? body.transactionHash!);
    const statusCode = ['CONFIRMED', 'FAILED'].includes(result.status) ? 200 : 202;
    return reply.code(statusCode).send({ payment: result });
  });
};
