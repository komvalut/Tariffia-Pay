import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAdmin, requireMerchant } from '../http.js';
import { config } from '../config.js';
import { renderInvoicePdf, renderReceiptPdf, type BillingPdfData } from '../documents/pdf.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';

type BillingDocumentRow = {
  id: string;
  invoice_number: string;
  merchant_id: string;
  customer_id: string | null;
  order_id: string;
  payment_id: string;
  amount: string;
  currency: string;
  payment_method: string;
  network: string;
  payment_status: string;
  transaction_id: string;
  paid_at: Date;
  merchant_name: string;
  merchant_email: string;
  customer_name: string | null;
  customer_email: string | null;
  order_reference: string | null;
  description: string;
  created_at: Date;
  receipt_id: string;
  receipt_public_id: string;
  receipt_issued_at: Date;
};

type PublicReceiptRow = Pick<BillingDocumentRow,
  'invoice_number' | 'merchant_name' | 'order_reference' | 'description' | 'amount' | 'currency' |
  'payment_method' | 'network' | 'payment_status' | 'transaction_id' | 'paid_at' | 'receipt_issued_at' | 'receipt_public_id'>;

const invoiceSelect = `SELECT i.id, i.invoice_number, i.merchant_id, i.customer_id, i.order_id, i.payment_id,
       i.amount::text AS amount, i.currency, i.payment_method, i.network, i.payment_status, i.transaction_id,
       i.paid_at, i.merchant_name, i.merchant_email, i.customer_name, i.customer_email,
       i.order_reference, i.description, i.created_at, r.id AS receipt_id,
       r.public_id AS receipt_public_id, r.issued_at AS receipt_issued_at
  FROM invoices i JOIN receipts r ON r.invoice_id = i.id`;

const publicReceiptSelect = `SELECT i.invoice_number, i.merchant_name, i.order_reference, i.description,
       i.amount::text AS amount, i.currency, i.payment_method, i.network, i.payment_status,
       i.transaction_id, i.paid_at, r.issued_at AS receipt_issued_at, r.public_id AS receipt_public_id
  FROM receipts r JOIN invoices i ON i.id = r.invoice_id`;

const publicIdPattern = /^[A-Za-z0-9_-]{43}$/;
const receiptHtml = readFile(new URL('../../web/receipt.html', import.meta.url), 'utf8');

export const billingDocumentRoutes: FastifyPluginAsync<{ db: Database; adapters: PaymentAdapterRegistry }> = async (app, { db, adapters }) => {
  app.get('/r/:publicId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { publicId } = request.params as { publicId: string };
    const receipt = await getPublicReceipt(db, publicId);
    if (!receipt) throw new HttpError(404, 'Receipt not found', 'not_found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await receiptHtml);
  });

  app.get('/v1/public/receipts/:publicId.pdf', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { publicId } = request.params as { publicId: string };
    const receipt = await getPublicReceipt(db, publicId);
    if (!receipt) throw new HttpError(404, 'Receipt not found', 'not_found');
    return pdfResponse(reply, renderReceiptPdf(publicPdfData(receipt, adapters)), `receipt-${receipt.invoice_number}.pdf`);
  });

  app.get('/v1/public/receipts/:publicId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { publicId } = request.params as { publicId: string };
    const receipt = await getPublicReceipt(db, publicId);
    if (!receipt) throw new HttpError(404, 'Receipt not found', 'not_found');
    return reply.header('cache-control', 'no-store').send({ receipt: publicReceiptView(receipt, adapters) });
  });

  app.get('/v1/invoices', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string };
    const result = await db.query<BillingDocumentRow>(
      `${invoiceSelect} WHERE i.merchant_id = $1 ORDER BY i.paid_at DESC, i.id DESC LIMIT $2`,
      [merchant.id, pageLimit(query.limit)],
    );
    return reply.send({ invoices: result.rows.map((row) => merchantInvoiceView(row, adapters)) });
  });

  app.get('/v1/invoices/:invoiceRef.pdf', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { invoiceRef } = request.params as { invoiceRef: string };
    const invoice = await getMerchantInvoice(db, merchant.id, invoiceRef);
    if (!invoice) throw new HttpError(404, 'Invoice not found', 'not_found');
    return pdfResponse(reply, renderInvoicePdf(merchantPdfData(invoice, adapters)), `invoice-${invoice.invoice_number}.pdf`);
  });

  app.get('/v1/invoices/:invoiceRef', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { invoiceRef } = request.params as { invoiceRef: string };
    const invoice = await getMerchantInvoice(db, merchant.id, invoiceRef);
    if (!invoice) throw new HttpError(404, 'Invoice not found', 'not_found');
    return reply.send({ invoice: merchantInvoiceView(invoice, adapters) });
  });

  app.get('/v1/receipts', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string };
    const result = await db.query<BillingDocumentRow>(
      `${invoiceSelect} WHERE i.merchant_id = $1 ORDER BY r.issued_at DESC, r.id DESC LIMIT $2`,
      [merchant.id, pageLimit(query.limit)],
    );
    return reply.send({ receipts: result.rows.map((row) => merchantReceiptView(row, adapters)) });
  });

  app.get('/v1/receipts/:receiptId.pdf', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { receiptId } = request.params as { receiptId: string };
    const receipt = await getMerchantReceipt(db, merchant.id, receiptId);
    if (!receipt) throw new HttpError(404, 'Receipt not found', 'not_found');
    return pdfResponse(reply, renderReceiptPdf(merchantPdfData(receipt, adapters)), `receipt-${receipt.invoice_number}.pdf`);
  });

  app.get('/v1/receipts/:receiptId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { receiptId } = request.params as { receiptId: string };
    const receipt = await getMerchantReceipt(db, merchant.id, receiptId);
    if (!receipt) throw new HttpError(404, 'Receipt not found', 'not_found');
    return reply.send({ receipt: merchantReceiptView(receipt, adapters) });
  });

  app.get('/v1/admin/invoices', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string };
    const result = await db.query<BillingDocumentRow>(
      `${invoiceSelect} ORDER BY i.paid_at DESC, i.id DESC LIMIT $1`, [pageLimit(query.limit)],
    );
    return reply.send({ invoices: result.rows.map((row) => adminInvoiceView(row, adapters)) });
  });

  app.get('/v1/admin/receipts', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string };
    const result = await db.query<BillingDocumentRow>(
      `${invoiceSelect} ORDER BY r.issued_at DESC, r.id DESC LIMIT $1`, [pageLimit(query.limit)],
    );
    return reply.send({ receipts: result.rows.map((row) => adminReceiptView(row, adapters)) });
  });
};

async function getPublicReceipt(db: Database, publicId: string): Promise<PublicReceiptRow | undefined> {
  if (!publicIdPattern.test(publicId)) return undefined;
  const result = await db.query<PublicReceiptRow>(
    `${publicReceiptSelect} WHERE r.public_id = $1 AND i.payment_status = 'CONFIRMED'`, [publicId],
  );
  return result.rows[0];
}

async function getMerchantInvoice(db: Database, merchantId: string, invoiceRef: string): Promise<BillingDocumentRow | undefined> {
  const result = await db.query<BillingDocumentRow>(
    `${invoiceSelect} WHERE i.merchant_id = $1 AND (i.id::text = $2 OR i.invoice_number = $2) LIMIT 1`,
    [merchantId, invoiceRef],
  );
  return result.rows[0];
}

async function getMerchantReceipt(db: Database, merchantId: string, receiptId: string): Promise<BillingDocumentRow | undefined> {
  const result = await db.query<BillingDocumentRow>(
    `${invoiceSelect} WHERE i.merchant_id = $1 AND (r.id::text = $2 OR i.invoice_number = $2) LIMIT 1`,
    [merchantId, receiptId],
  );
  return result.rows[0];
}

/** The invoice (with its receipt) issued for one payment, scoped to the owning merchant. */
export async function getPaymentInvoice(db: Database, merchantId: string, paymentId: string): Promise<BillingDocumentRow | undefined> {
  const result = await db.query<BillingDocumentRow>(
    `${invoiceSelect} WHERE i.merchant_id = $1 AND i.payment_id = $2 LIMIT 1`,
    [merchantId, paymentId],
  );
  return result.rows[0];
}

export function merchantInvoiceView(row: BillingDocumentRow, adapters: PaymentAdapterRegistry) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    merchantId: row.merchant_id,
    customerId: row.customer_id,
    orderId: row.order_id,
    paymentId: row.payment_id,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters),
    network: row.network,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    merchant: { name: row.merchant_name, email: row.merchant_email },
    customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, email: row.customer_email } : null,
    orderReference: row.order_reference,
    description: row.description,
    receipt: {
      id: row.receipt_id,
      publicId: row.receipt_public_id,
      issuedAt: row.receipt_issued_at,
      publicUrl: publicReceiptUrl(row.receipt_public_id),
    },
    createdAt: row.created_at,
  };
}

function merchantReceiptView(row: BillingDocumentRow, adapters: PaymentAdapterRegistry) {
  return {
    id: row.receipt_id,
    publicId: row.receipt_public_id,
    invoiceId: row.id,
    invoiceNumber: row.invoice_number,
    paymentId: row.payment_id,
    orderId: row.order_id,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters),
    network: row.network,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    issuedAt: row.receipt_issued_at,
    merchant: { name: row.merchant_name, email: row.merchant_email },
    customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, email: row.customer_email } : null,
    orderReference: row.order_reference,
    description: row.description,
    publicUrl: publicReceiptUrl(row.receipt_public_id),
  };
}

function adminInvoiceView(row: BillingDocumentRow, adapters: PaymentAdapterRegistry) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    customerId: row.customer_id,
    customerName: row.customer_name,
    orderId: row.order_id,
    paymentId: row.payment_id,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters),
    network: row.network,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    description: row.description,
  };
}

function adminReceiptView(row: BillingDocumentRow, adapters: PaymentAdapterRegistry) {
  return {
    id: row.receipt_id,
    invoiceId: row.id,
    invoiceNumber: row.invoice_number,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    customerId: row.customer_id,
    customerName: row.customer_name,
    paymentId: row.payment_id,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters),
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    issuedAt: row.receipt_issued_at,
  };
}

function publicReceiptView(row: PublicReceiptRow, adapters: PaymentAdapterRegistry) {
  return {
    invoiceNumber: row.invoice_number,
    merchantName: row.merchant_name,
    orderReference: row.order_reference,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters).name,
    network: row.network,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    issuedAt: row.receipt_issued_at,
  };
}

function merchantPdfData(row: BillingDocumentRow, adapters: PaymentAdapterRegistry): BillingPdfData {
  return {
    invoiceNumber: row.invoice_number,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters).name,
    network: row.network,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    merchantName: row.merchant_name,
    merchantEmail: row.merchant_email,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    orderReference: row.order_reference,
  };
}

function publicPdfData(row: PublicReceiptRow, adapters: PaymentAdapterRegistry): BillingPdfData {
  return {
    invoiceNumber: row.invoice_number,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    paymentMethod: paymentMethod(row.payment_method, adapters).name,
    network: row.network,
    paymentStatus: row.payment_status,
    transactionId: row.transaction_id,
    paidAt: row.paid_at,
    merchantName: row.merchant_name,
    orderReference: row.order_reference,
  };
}

function paymentMethod(id: string, adapters: PaymentAdapterRegistry) {
  const manifest = adapters.getManifest(id);
  return { id, name: manifest?.name ?? id };
}

function publicReceiptUrl(publicId: string): string {
  return `${new URL(config.PUBLIC_BASE_URL).origin}/r/${publicId}`;
}

function pdfResponse(reply: FastifyReply, pdf: Buffer, filename: string) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return reply.type('application/pdf')
    .header('cache-control', 'no-store')
    .header('content-disposition', `attachment; filename="${safeFilename}"`)
    .send(pdf);
}

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}
