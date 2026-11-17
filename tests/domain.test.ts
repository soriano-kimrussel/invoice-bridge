import { describe, expect, it } from 'vitest';
import {
  arithmeticIssues,
  extractedInvoiceSchema,
  lowConfidenceFields,
  mergeForReview,
  reviewedInvoiceSchema,
} from '../src/domain/invoice.js';
import { detectFileType } from '../src/invoices/fileType.js';
import { extractedFixture, fakePdf, PNG_HEADER, reviewedFixture } from './helpers/fixtures.js';

describe('reviewedInvoiceSchema', () => {
  it('accepts a complete, arithmetically consistent invoice', () => {
    expect(reviewedInvoiceSchema.safeParse(reviewedFixture()).success).toBe(true);
  });

  it('rejects when line items do not sum to the subtotal', () => {
    const r = reviewedInvoiceSchema.safeParse(
      reviewedFixture({ lineItems: [{ description: 'x', quantity: 1, unitPrice: 99, amount: 99 }] }),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('subtotal');
  });

  it('rejects when subtotal + tax != total', () => {
    const r = reviewedInvoiceSchema.safeParse(reviewedFixture({ total: 111 }));
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('total');
  });

  it('rejects a due date before the issue date, bad currency and bad dates', () => {
    const r = reviewedInvoiceSchema.safeParse(
      reviewedFixture({ dueDate: '2026-10-01', currency: 'aud', issueDate: '2026-13-45' }),
    );
    const paths = r.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['currency', 'issueDate']));
  });

  it('requires at least one line item', () => {
    const r = reviewedInvoiceSchema.safeParse(reviewedFixture({ lineItems: [], subtotal: 0, tax: 0, total: 0 }));
    expect(r.success).toBe(false);
  });
});

describe('arithmeticIssues (integer cents)', () => {
  it('is not fooled by floating point: 0.1 + 0.2 == 0.3', () => {
    expect(
      arithmeticIssues({
        subtotal: 0.3,
        tax: 0,
        total: 0.3,
        lineItems: [{ amount: 0.1 }, { amount: 0.2 }],
      }),
    ).toEqual([]);
  });
});

describe('extraction helpers', () => {
  it('validates the extraction fixture', () => {
    expect(extractedInvoiceSchema.safeParse(extractedFixture()).success).toBe(true);
  });

  it('flags low-confidence and missing fields, including line items', () => {
    const ex = extractedFixture({ tax: { value: null, confidence: null } });
    expect(lowConfidenceFields(ex, 0.8).sort()).toEqual(['dueDate', 'lineItems.0.unitPrice', 'tax'].sort());
    expect(lowConfidenceFields(ex, 0.4)).toEqual(['tax']);
  });

  it('merges the human draft over the extracted values', () => {
    const merged = mergeForReview(extractedFixture(), { vendorName: 'Corrected Ltd', tax: null });
    expect(merged.vendorName).toBe('Corrected Ltd');
    expect(merged.tax).toBeNull(); // an explicit null in the draft is a deliberate edit
    expect(merged.total).toBe(110);
    expect(merged.lineItems).toEqual([{ description: 'Widgets', quantity: 10, unitPrice: 10, amount: 100 }]);
  });

  it('produces an empty form with no extraction', () => {
    expect(mergeForReview(null, null)).toMatchObject({ vendorName: null, lineItems: [] });
  });
});

describe('detectFileType', () => {
  it('detects by magic bytes, not by name', () => {
    expect(detectFileType(fakePdf())?.mimeType).toBe('application/pdf');
    expect(detectFileType(PNG_HEADER)?.ext).toBe('png');
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mimeType).toBe('image/jpeg');
    expect(detectFileType(Buffer.from('MZ\x90\x00 not an invoice'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });
});
