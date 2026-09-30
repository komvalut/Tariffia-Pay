import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { runIdempotently } from '../idempotency.js';
import type { MerchantContext } from '../http.js';
import type { AdapterPaymentDetails } from '../payment-adapter.js';
import type { PaymentAdapter } from '../payment-adapter.js';
import { PaymentAdapterError } from '../payment-adapters/errors.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';
import type { CreateOrderInput } from '../schemas.js';
import { checkoutQrUrlForPayment, checkoutUrlForPayment } from '../checkout-links.js';
import { config } from '../config.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import { hashRequest, newId } from '../security.js';
import type { PoolClient } from 'pg';

export class PaymentCoreService {
  constructor(private readonly db: Database, private readonly adapters: PaymentAdapterRegistry) {}

  async createPaymentLink(input: {
    merchant: MerchantContext;
    body: CreateOrderInput;
    idempotencyKey: string;
    scope: string;
    onPaymentCreated?: (client: PoolClient, payment: {
      paymentId: string; orderId: string; merchantId: string; amount: string; currency: string; network: string;
    }) => Promise<{ response?: Record<string, unknown>; webhookData?: Record<string, unknown> } | void>;
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
        const paymentIdempotencyKey = hashRequest({ scope: input.scope, key: input.idempotencyKey });
        const expiresAt = new Date(Date.now() + config.PAYMENT_EXPIRATION_MINUTES * 60_000);
        let adapter: PaymentAdapter;
        let adapterDetails: AdapterPaymentDetails;
        try {
          adapter = input.body.adapter
            ? this.adapters.getForNewPayments(input.body.adapter)
            : this.adapters.getDefaultForNewPayments();
          adapterDetails = await this.adapters.createRequest(adapter.id, {
            paymentId,
            idempotencyKey: paymentIdempotencyKey,
            amount: input.body.amount,
            currency: input.body.currency,
            recipient: input.merchant.wallet_address,
            description: input.body.description,
            expiresAt: expiresAt.toISOString(),
          });
        } catch (error) {
          if (error instanceof PaymentAdapterError && error.code === 'invalid_request') {
            throw new HttpError(422, 'Payment request is not supported by the selected method', 'payment_setup_failed');
          }
          if (error instanceof PaymentAdapterError && error.code === 'invalid_response') {
            throw new HttpError(502, 'Payment adapter returned invalid payment details', 'adapter_invalid_response');
          }
          throw new HttpError(503, 'Selected payment method is temporarily unavailable', 'adapter_unavailable');
        }

        const order = await client.query(
          `INSERT INTO orders (id, merchant_id, customer_id, reference, description, amount, currency, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8::jsonb)
           RETURNING id, customer_id AS "customerId", reference, description, amount::text AS amount,
             currency, status, metadata, created_at AS "createdAt"`,
          [
             orderId, input.merchant.id, input.body.customerId ?? null, input.body.reference ?? null,
             input.body.description, input.body.amount, adapterDetails.currency, JSON.stringify(input.body.metadata),
          ],
        );
        const payment = await client.query(
          `INSERT INTO payments (id, merchant_id, order_id, amount, amount_base_units, currency, adapter, network,
                                 recipient_address, token_address, adapter_data, status, idempotency_key, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'PENDING', $12, $13)
            RETURNING id, order_id AS "orderId", amount::text AS amount, currency, adapter, network,
              recipient_address AS "recipientAddress", token_address AS "tokenAddress",
              amount_base_units::text AS "amountBaseUnits", status, tx_hash AS "txHash", tx_hash AS "transactionId",
              expires_at AS "expiresAt",
             created_at AS "createdAt"`,
          [
            paymentId, input.merchant.id, orderId, input.body.amount, adapterDetails.amountBaseUnits,
            adapterDetails.currency, adapterDetails.adapter, adapterDetails.network,
            adapterDetails.recipientAddress, adapterDetails.tokenAddress,
            JSON.stringify(adapterDetails.adapterData), paymentIdempotencyKey, expiresAt,
          ],
        );
        await client.query(
          `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
           VALUES ($1, $2, $3, $4, 'PAYMENT_CREATED', $5, $6, $7, $8::jsonb)`,
          [newId(), input.merchant.id, orderId, paymentId, input.body.amount, adapterDetails.currency, paymentId, JSON.stringify({ status: 'PENDING' })],
        );
        const extension = await input.onPaymentCreated?.(client, {
          paymentId, orderId, merchantId: input.merchant.id, amount: input.body.amount,
          currency: adapterDetails.currency, network: adapterDetails.network,
        });
        await enqueueWebhookEvent({
          client,
          merchantId: input.merchant.id,
          eventType: 'payment.created',
          resourceId: paymentId,
          data: {
            paymentId,
            orderId,
            adapter: adapterDetails.adapter,
            amount: input.body.amount,
            currency: adapterDetails.currency,
            network: adapterDetails.network,
            recipientAddress: adapterDetails.recipientAddress,
            status: 'PENDING', expiresAt: expiresAt.toISOString(),
            ...extension?.webhookData,
          },
        });

        const checkoutUrl = checkoutUrlForPayment(paymentId);
        const qrUrl = checkoutQrUrlForPayment(paymentId);
        const manifest = this.adapters.getManifest(adapterDetails.adapter);
        const paymentMethod = manifest ? {
          id: manifest.id,
          name: manifest.name,
          paymentRequestFormat: manifest.capabilities.paymentRequestFormat,
        } : undefined;
        return {
          status: 201,
          body: {
            order: order.rows[0],
            payment: {
              ...payment.rows[0],
              ...(paymentMethod ? { paymentMethod } : {}),
              ...(paymentMethod?.paymentRequestFormat === 'invoice'
                ? { paymentRequest: adapterDetails.recipientAddress }
                : {}),
            },
            checkoutUrl,
            qrUrl,
            ...extension?.response,
          },
        };
      },
    });
  }
}
