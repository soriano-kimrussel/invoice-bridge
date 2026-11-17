import { z } from 'zod';

/**
 * Typed boundary between the extraction layer (Azure DI → ExtractedInvoice),
 * the review layer (human → ReviewedInvoice) and the accounting layer
 * (ReviewedInvoice → bill). These schemas depend only on zod so the React UI
 * can import them too.
 */

export const INVOICE_STATUSES = [
  'pending',
  'processing',
  'needs_review',
  'approved',
  'submitted',
  'posted',
  'mismatch',
  'rejected',
  'failed',
] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'invalid date');

const money = z.number().finite();
const currency = z.string().regex(/^[A-Z]{3}$/, 'expected ISO 4217 code, e.g. AUD');
const confidence = z.number().min(0).max(1).nullable();

/** One extracted value plus the model's confidence in it (null = not reported). */
const field = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.nullable(), confidence });

// ---------------------------------------------------------------------------
// Extraction output (what the worker stores in `invoices.extracted`)
// ---------------------------------------------------------------------------

export const extractedLineItemSchema = z.object({
  description: field(z.string()),
  quantity: field(money),
  unitPrice: field(money),
  amount: field(money),
});

export const extractedInvoiceSchema = z.object({
  vendorName: field(z.string()),
  invoiceNumber: field(z.string()),
  issueDate: field(isoDate),
  dueDate: field(isoDate),
  currency: field(currency),
  subtotal: field(money),
  tax: field(money),
  total: field(money),
  lineItems: z.array(extractedLineItemSchema),
  /** Model id + version, for traceability. */
  modelId: z.string(),
});

export type ExtractedField<T> = { value: T | null; confidence: number | null };
export type ExtractedLineItem = z.infer<typeof extractedLineItemSchema>;
export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;

// ---------------------------------------------------------------------------
// Review (what a human saves / approves; stored in `invoices.reviewed`)
// ---------------------------------------------------------------------------

export const reviewedLineItemSchema = z.object({
  description: z.string().trim().min(1, 'description is required'),
  quantity: money.positive('quantity must be > 0'),
  unitPrice: money,
  amount: money,
});

/** Drafts may be incomplete: every field optional, but whatever is present must be well-formed. */
export const reviewDraftSchema = z.object({
  vendorName: z.string().trim().nullable().optional(),
  invoiceNumber: z.string().trim().nullable().optional(),
  issueDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  currency: currency.nullable().optional(),
  subtotal: money.nullable().optional(),
  tax: money.nullable().optional(),
  total: money.nullable().optional(),
  lineItems: z.array(reviewedLineItemSchema).optional(),
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

/** What must be true before an invoice can be approved and sent to accounting. */
export const reviewedInvoiceSchema = z
  .object({
    vendorName: z.string().trim().min(1, 'vendor is required'),
    invoiceNumber: z.string().trim().min(1, 'invoice number is required'),
    issueDate: isoDate,
    dueDate: isoDate,
    currency,
    subtotal: money,
    tax: money.min(0),
    total: money.positive('total must be > 0'),
    lineItems: z.array(reviewedLineItemSchema).min(1, 'at least one line item is required'),
  })
  .superRefine((inv, ctx) => {
    for (const issue of arithmeticIssues(inv)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
    if (inv.dueDate < inv.issueDate) {
      ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'due date is before issue date' });
    }
  });
export type ReviewedInvoice = z.infer<typeof reviewedInvoiceSchema>;

// ---------------------------------------------------------------------------
// Money arithmetic, done in integer cents so floating point never decides a total.
// ---------------------------------------------------------------------------

export const toCents = (n: number): number => Math.round(n * 100);

export function arithmeticIssues(inv: {
  subtotal: number;
  tax: number;
  total: number;
  lineItems: { amount: number }[];
}): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const lineSum = inv.lineItems.reduce((sum, li) => sum + toCents(li.amount), 0);
  if (lineSum !== toCents(inv.subtotal)) {
    issues.push({
      path: 'subtotal',
      message: `line items sum to ${(lineSum / 100).toFixed(2)} but subtotal is ${inv.subtotal.toFixed(2)}`,
    });
  }
  if (toCents(inv.subtotal) + toCents(inv.tax) !== toCents(inv.total)) {
    issues.push({
      path: 'total',
      message: `subtotal + tax = ${((toCents(inv.subtotal) + toCents(inv.tax)) / 100).toFixed(2)} but total is ${inv.total.toFixed(2)}`,
    });
  }
  return issues;
}

/**
 * Starting point for the review form: the human's saved draft wins, otherwise
 * the extracted value. Pure, so the UI and the approve endpoint agree.
 */
export function mergeForReview(
  extracted: ExtractedInvoice | null,
  draft: ReviewDraft | null,
): ReviewDraft {
  const pick = <K extends keyof ReviewDraft & keyof ExtractedInvoice>(k: K) =>
    draft && draft[k] !== undefined
      ? draft[k]
      : ((extracted?.[k] as ExtractedField<unknown> | undefined)?.value ?? null);

  return {
    vendorName: pick('vendorName') as string | null,
    invoiceNumber: pick('invoiceNumber') as string | null,
    issueDate: pick('issueDate') as string | null,
    dueDate: pick('dueDate') as string | null,
    currency: pick('currency') as string | null,
    subtotal: pick('subtotal') as number | null,
    tax: pick('tax') as number | null,
    total: pick('total') as number | null,
    lineItems:
      draft?.lineItems ??
      (extracted?.lineItems ?? []).map((li) => ({
        description: li.description.value ?? '',
        quantity: li.quantity.value ?? 1,
        unitPrice: li.unitPrice.value ?? li.amount.value ?? 0,
        amount: li.amount.value ?? 0,
      })),
  };
}

/** Names of top-level fields whose confidence is below the threshold (or unknown while a value exists). */
export function lowConfidenceFields(extracted: ExtractedInvoice, threshold: number): string[] {
  const keys = [
    'vendorName',
    'invoiceNumber',
    'issueDate',
    'dueDate',
    'currency',
    'subtotal',
    'tax',
    'total',
  ] as const;
  const low: string[] = keys.filter((k) => {
    const f = extracted[k];
    return f.value === null || (f.confidence ?? 0) < threshold;
  });
  extracted.lineItems.forEach((li, i) => {
    for (const k of ['description', 'quantity', 'unitPrice', 'amount'] as const) {
      const f = li[k];
      if (f.value !== null && (f.confidence ?? 0) < threshold) low.push(`lineItems.${i}.${k}`);
    }
  });
  return low;
}
