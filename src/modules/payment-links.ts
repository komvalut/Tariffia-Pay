import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { parsePagination, paginate } from '../pagination.js';
import { createOrderSchema, updatePaymentLinkSchema } from '../schemas.js';
import { checkoutQrUrlForPayment, checkoutUrlForPayment } from '../checkout-links.js';
import type { PaymentCoreService } from '../services/payment-core-service.js';
import type { AuditLogService } from '../services/audit-log-service.js';

type PaymentLinkRecord = {
  paymentId: string;
  orderId: string;
  reference: string | null;
  description: string;
  amount: string;
  currency: string;
  status: string;
  transactionHash: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  linkEnabled: boolean | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
};

// A payment with no management row is active; only an explicit disabled/deleted row pauses it.
const linkSelect = `SELECT p.id AS "paymentId", o.id AS "orderId", o.reference, o.description,
  o.amount::text AS amount, o.currency, p.status, p.tx_hash AS "transactionHash",
  p.expires_at AS "expiresAt", p.created_at AS "createdAt",
  pl.enabled AS "linkEnabled", pl.disabled_at AS "disabledAt", pl.deleted_at AS "deletedAt"
  FROM payments p
  JOIN orders o ON o.id = p.order_id
  LEFT JOIN payment_links pl ON pl.payment_id = p.id
 WHERE p.merchant_id = $1`;

export function paymentLinkView(link: PaymentLinkRecord) {
  return {
    id: link.paymentId,
    orderId: link.orderId,
    reference: link.reference,
    description: link.description,
    amount: link.amount,
    currency: link.currency,
    status: link.status,
    transactionHash: link.transactionHash,
    enabled: link.linkEnabled !== false,
    disabledAt: link.disabledAt,
    expiresAt: link.expiresAt,
    createdAt: link.createdAt,
    checkoutUrl: checkoutUrlForPayment(link.paymentId),
    qrUrl: checkoutQrUrlForPayment(link.paymentId),
  };
}

export const paymentLinkRoutes: FastifyPluginAsync<{ db: Database; paymentCore: PaymentCoreService; auditLog: AuditLogService }> = async (app, { db, paymentCore, auditLog }) => {
  app.get('/v1/payment-links', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; offset?: string };
    const { limit, offset } = parsePagination(query);
    const result = await db.query<PaymentLinkRecord>(
      `${linkSelect} AND pl.deleted_at IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
      [merchant.id, limit + 1, offset],
    );
    const page = paginate(result.rows, limit, offset);
    return reply.send({ paymentLinks: page.items.map(paymentLinkView), pagination: page.pagination });
  });

  app.get('/v1/payment-links/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const result = await db.query<PaymentLinkRecord>(
      `${linkSelect} AND p.id = $2 AND pl.deleted_at IS NULL`,
      [merchant.id, paymentId],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Payment link not found', 'not_found');
    return reply.send({ paymentLink: paymentLinkView(result.rows[0]) });
  });

  app.patch('/v1/payment-links/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const body = parseBody(updatePaymentLinkSchema, request.body);
    const existing = await db.query<{ linkEnabled: boolean | null; deletedAt: Date | null }>(
      `${linkSelect} AND p.id = $2`,
      [merchant.id, paymentId],
    );
    const link = existing.rows[0];
    if (!link || link.deletedAt) throw new HttpError(404, 'Payment link not found', 'not_found');
    const disabledAt = body.enabled ? null : new Date();
    await db.query(
      `INSERT INTO payment_links (payment_id, merchant_id, enabled, disabled_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (payment_id) DO UPDATE SET enabled = $3, disabled_at = $4, updated_at = now()`,
      [paymentId, merchant.id, body.enabled, disabledAt],
    );
    const updated = await db.query<PaymentLinkRecord>(`${linkSelect} AND p.id = $2`, [merchant.id, paymentId]);
    await auditLog.record({
      actorType: 'merchant', actorId: merchant.id,
      action: body.enabled ? 'payment_link.enable' : 'payment_link.disable',
      resourceType: 'payment_link', resourceId: paymentId, metadata: { enabled: body.enabled },
    });
    return reply.send({ paymentLink: paymentLinkView(updated.rows[0]!) });
  });

  app.delete('/v1/payment-links/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const existing = await db.query<{ deletedAt: Date | null }>(`${linkSelect} AND p.id = $2`, [merchant.id, paymentId]);
    const link = existing.rows[0];
    if (!link || link.deletedAt) throw new HttpError(404, 'Payment link not found', 'not_found');
    const now = new Date();
    await db.query(
      `INSERT INTO payment_links (payment_id, merchant_id, enabled, disabled_at, deleted_at)
       VALUES ($1, $2, false, $3, $3)
       ON CONFLICT (payment_id) DO UPDATE SET enabled = false, disabled_at = $3, deleted_at = $3, updated_at = now()`,
      [paymentId, merchant.id, now],
    );
    await auditLog.record({
      actorType: 'merchant', actorId: merchant.id, action: 'payment_link.delete',
      resourceType: 'payment_link', resourceId: paymentId,
    });
    return reply.code(204).send();
  });

  app.post('/v1/payment-links', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createOrderSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    const result = await paymentCore.createPaymentLink({
      merchant,
      body,
      idempotencyKey,
      scope: `merchant:${merchant.id}:POST:/v1/payment-links`,
    });
    return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.status).send(result.body);
  });
};
