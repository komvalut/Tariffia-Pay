import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { newId } from '../security.js';

export type ConfirmedPaymentDocumentInput = {
  paymentId: string;
  merchantId: string;
  orderId: string;
  amount: string;
  currency: string;
  adapter: string;
  network: string;
  transactionId: string;
  paidAt: Date;
};

export type CreatedBillingDocuments = {
  invoiceId: string;
  invoiceNumber: string;
  receiptId: string;
  receiptPublicId: string;
  receiptUrl: string;
};

export async function createBillingDocuments(
  client: PoolClient,
  payment: ConfirmedPaymentDocumentInput,
): Promise<CreatedBillingDocuments> {
  const existing = await client.query<{
    id: string; invoice_number: string; receipt_id: string | null; public_id: string | null;
  }>(
    `SELECT i.id, i.invoice_number, r.id AS receipt_id, r.public_id
       FROM invoices i LEFT JOIN receipts r ON r.invoice_id = i.id
      WHERE i.payment_id = $1`,
    [payment.paymentId],
  );
  let invoiceId = existing.rows[0]?.id;
  let invoiceNumber = existing.rows[0]?.invoice_number;

  if (!invoiceId || !invoiceNumber) {
    const context = await client.query<{
      customer_id: string | null;
      order_reference: string | null;
      description: string;
      merchant_name: string;
      merchant_email: string;
      customer_name: string | null;
      customer_email: string | null;
    }>(
      `SELECT o.customer_id, o.reference AS order_reference, o.description,
              m.name AS merchant_name, m.email AS merchant_email,
              c.name AS customer_name, c.email AS customer_email
         FROM orders o JOIN merchants m ON m.id = o.merchant_id
         LEFT JOIN customers c ON c.id = o.customer_id AND c.merchant_id = o.merchant_id
        WHERE o.id = $1 AND o.merchant_id = $2`,
      [payment.orderId, payment.merchantId],
    );
    const snapshot = context.rows[0];
    if (!snapshot) throw new Error('Confirmed payment order or merchant snapshot was not found');

    invoiceId = newId();
    invoiceNumber = `INV-${payment.paidAt.getUTCFullYear()}-${invoiceId.replaceAll('-', '').toUpperCase()}`;
    await client.query(
      `INSERT INTO invoices (
         id, invoice_number, merchant_id, customer_id, order_id, payment_id, amount, currency,
         payment_method, network, payment_status, transaction_id, paid_at, merchant_name, merchant_email,
         customer_name, customer_email, order_reference, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONFIRMED', $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (payment_id) DO NOTHING`,
      [
        invoiceId, invoiceNumber, payment.merchantId, snapshot.customer_id, payment.orderId, payment.paymentId,
        payment.amount, payment.currency, payment.adapter, payment.network, payment.transactionId, payment.paidAt,
        snapshot.merchant_name, snapshot.merchant_email, snapshot.customer_name, snapshot.customer_email,
        snapshot.order_reference, snapshot.description,
      ],
    );
    const storedInvoice = await client.query<{ id: string; invoice_number: string }>(
      'SELECT id, invoice_number FROM invoices WHERE payment_id = $1', [payment.paymentId],
    );
    invoiceId = storedInvoice.rows[0]?.id;
    invoiceNumber = storedInvoice.rows[0]?.invoice_number;
    if (!invoiceId || !invoiceNumber) throw new Error('Confirmed payment invoice was not persisted');
  }

  let receiptId = existing.rows[0]?.receipt_id ?? null;
  let receiptPublicId = existing.rows[0]?.public_id ?? null;
  if (!receiptId || !receiptPublicId) {
    const candidateReceiptId = newId();
    const candidatePublicId = randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO receipts (id, public_id, invoice_id, payment_id, merchant_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payment_id) DO NOTHING`,
      [candidateReceiptId, candidatePublicId, invoiceId, payment.paymentId, payment.merchantId],
    );
    const storedReceipt = await client.query<{ id: string; public_id: string }>(
      'SELECT id, public_id FROM receipts WHERE payment_id = $1', [payment.paymentId],
    );
    receiptId = storedReceipt.rows[0]?.id ?? null;
    receiptPublicId = storedReceipt.rows[0]?.public_id ?? null;
  }
  if (!receiptId || !receiptPublicId) throw new Error('Confirmed payment receipt was not persisted');

  return {
    invoiceId,
    invoiceNumber,
    receiptId,
    receiptPublicId,
    receiptUrl: `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/r/${receiptPublicId}`,
  };
}
