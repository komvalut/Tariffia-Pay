import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { runIdempotently } from '../idempotency.js';
import type { MerchantContext } from '../http.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../payment-adapter.js';
import type { CreateOrderInput } from '../schemas.js';
import { newId } from '../security.js';
import { checkoutQrUrlForPayment, checkoutUrlForPayment } from '../checkout-links.js';
import { config } from '../config.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';

export class PaymentCoreService {
  constructor(private readonly db: Database, private readonly adapter: PaymentAdapter) {}

  async createPaymentLink(input: {
    merchant: MerchantContext;
    body: CreateOrderInput;
    idempotencyKey: string;
    scope: string;
  }) {
    return runIdempotently({
      db: this.db,
      scope: input.scope,
      key: input.idempotencyKey,
      request: input.body,
      work: async (client) => {
        if (input.body.customerId) {
          const customer = await client.query(
            'SELECT id FROM customers WHERE id = $1 AND merchant_id = $2',
            [input.body.customerId, input.merchant.id],
          );
          if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');
        }

        const orderId = newId();
        const paymentId = newId();
        const expiresAt = new Date(Date.now() + config.PAYMENT_EXPIRATION_MINUTES * 60_000);
        let adapterDetails: AdapterPaymentDetails;
        try {
          adapterDetails = await this.adapter.createRequest({
            paymentId,
            amount: input.body.amount,
            currency: input.body.currency,
            recipient: input.merchant.wallet_address,
            expiresAt: expiresAt.toISOString(),
          });
        } catch (error) {
          throw new HttpError(422, error instanceof Error ? error.message : 'Payment request setup failed', 'payment_setup_failed');
        }

        const order = await client.query(
          `INSERT INTO orders (id, merchant_id, customer_id, reference, description, amount, currency, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, 'USDC', 'PENDING', $7::jsonb)
           RETURNING id, customer_id AS "customerId", reference, description, amount::text AS amount,
             currency, status, metadata, created_at AS "createdAt"`,
          [
            orderId, input.merchant.id, input.body.customerId ?? null, input.body.reference ?? null,
            input.body.description, input.body.amount, JSON.stringify(input.body.metadata),
          ],
        );
        const payment = await client.query(
          `INSERT INTO payments (id, merchant_id, order_id, amount, amount_base_units, currency, adapter, network,
                                 recipient_address, token_address, adapter_data, status, idempotency_key, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'PENDING', $12, $13)
           RETURNING id, order_id AS "orderId", amount::text AS amount, currency, adapter, network,
             recipient_address AS "recipientAddress", token_address AS "tokenAddress", adapter_data AS "adapterData",
             amount_base_units::text AS "amountBaseUnits", status, tx_hash AS "txHash", expires_at AS "expiresAt",
             created_at AS "createdAt"`,
          [
            paymentId, input.merchant.id, orderId, input.body.amount, adapterDetails.adapterData.amountBaseUnits,
            adapterDetails.currency, adapterDetails.adapter, adapterDetails.network,
            adapterDetails.recipientAddress.toLowerCase(), adapterDetails.tokenAddress.toLowerCase(),
            JSON.stringify(adapterDetails.adapterData), input.idempotencyKey, expiresAt,
          ],
        );
        await client.query(
          `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
           VALUES ($1, $2, $3, $4, 'PAYMENT_CREATED', $5, 'USDC', $6, $7::jsonb)`,
          [newId(), input.merchant.id, orderId, paymentId, input.body.amount, paymentId, JSON.stringify({ status: 'PENDING' })],
        );
        await enqueueWebhookEvent({
          client,
          merchantId: input.merchant.id,
          eventType: 'payment.created',
          resourceId: paymentId,
          data: {
            paymentId,
            orderId,
            amount: input.body.amount,
            currency: adapterDetails.currency,
            network: adapterDetails.network,
            recipientAddress: adapterDetails.recipientAddress.toLowerCase(),
            status: 'PENDING', expiresAt: expiresAt.toISOString(),
          },
        });

        const checkoutUrl = checkoutUrlForPayment(paymentId);
        const qrUrl = checkoutQrUrlForPayment(paymentId);
        return {
          status: 201,
          body: { order: order.rows[0], payment: payment.rows[0], checkoutUrl, qrUrl },
        };
      },
    });
  }
}
