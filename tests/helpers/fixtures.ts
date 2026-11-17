import type { ExtractedInvoice, ReviewedInvoice } from '../../src/domain/invoice.js';

/** A tiny but valid-looking PDF. Pass a seed to get distinct bytes (and so a distinct content hash). */
export function fakePdf(seed = 'default'): Buffer {
  return Buffer.from(`%PDF-1.4\n% invoice-bridge test fixture ${seed}\n%%EOF\n`, 'latin1');
}

export const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const f = <T>(value: T | null, confidence: number | null = 0.95) => ({ value, confidence });

export function extractedFixture(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    vendorName: f('Acme Supplies Pty Ltd', 0.98),
    invoiceNumber: f('INV-1001', 0.97),
    issueDate: f('2026-11-01', 0.96),
    dueDate: f('2026-11-30', 0.6), // deliberately low confidence
    currency: f('AUD', 0.9),
    subtotal: f(100, 0.95),
    tax: f(10, 0.95),
    total: f(110, 0.99),
    lineItems: [
      {
        description: f('Widgets', 0.93),
        quantity: f(10, 0.92),
        unitPrice: f(10, 0.5), // low
        amount: f(100, 0.94),
      },
    ],
    modelId: 'prebuilt-invoice',
    ...overrides,
  };
}

export function reviewedFixture(overrides: Partial<ReviewedInvoice> = {}): ReviewedInvoice {
  return {
    vendorName: 'Acme Supplies Pty Ltd',
    invoiceNumber: 'INV-1001',
    issueDate: '2026-11-01',
    dueDate: '2026-11-30',
    currency: 'AUD',
    subtotal: 100,
    tax: 10,
    total: 110,
    lineItems: [{ description: 'Widgets', quantity: 10, unitPrice: 10, amount: 100 }],
    ...overrides,
  };
}

/** Build a multipart/form-data body for app.inject(). */
export function multipartBody(file: Buffer, filename: string, field = 'file') {
  const boundary = `----invoicebridge${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
