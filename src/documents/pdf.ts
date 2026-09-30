export type BillingPdfData = {
  invoiceNumber: string;
  description: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  network: string;
  paymentStatus: string;
  transactionId: string;
  paidAt: Date | string;
  merchantName: string;
  merchantEmail?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  orderReference?: string | null;
};

export function renderInvoicePdf(data: BillingPdfData): Buffer {
  return renderBillingPdf('Invoice', data, true);
}

export function renderReceiptPdf(data: BillingPdfData): Buffer {
  return renderBillingPdf('Payment receipt', data, false);
}

function renderBillingPdf(title: string, data: BillingPdfData, includeContactDetails: boolean): Buffer {
  const fields: Array<[string, string]> = [
    ['Invoice number', data.invoiceNumber],
    ['Status', data.paymentStatus],
    ['Description', data.description],
    ['Amount', `${data.amount} ${data.currency}`],
    ['Payment method', data.paymentMethod],
    ['Network', data.network],
    ['Transaction ID', data.transactionId],
    ['Paid at', new Date(data.paidAt).toISOString()],
    ['Merchant', data.merchantName],
  ];
  if (includeContactDetails && data.merchantEmail) fields.push(['Merchant email', data.merchantEmail]);
  if (data.orderReference) fields.push(['Order reference', data.orderReference]);
  if (data.customerName) fields.push(['Customer', data.customerName]);
  if (includeContactDetails && data.customerEmail) fields.push(['Customer email', data.customerEmail]);

  const lines = [title, '', ...fields.flatMap(([label, value]) => wrapLine(`${label}: ${value}`)), '', 'Tariffia Pay'];
  const content = [
    'BT',
    '/F1 20 Tf',
    '50 760 Td',
    `(${escapePdfText(lines[0] ?? title)}) Tj`,
    '/F1 11 Tf',
    ...lines.slice(1).flatMap((line) => ['0 -23 Td', `(${escapePdfText(line)}) Tj`]),
    'ET',
  ].join('\n');
  const stream = `${content}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
  ];

  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'ascii'));
    document += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'ascii');
}

function wrapLine(value: string, width = 86): string[] {
  const normalized = value.normalize('NFKD').replace(/[^\x20-\x7e]/g, '?');
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}
