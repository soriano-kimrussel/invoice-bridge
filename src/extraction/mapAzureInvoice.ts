import type { AnalyzeResultOutput, DocumentFieldOutput } from '@azure-rest/ai-document-intelligence';
import {
  extractedInvoiceSchema,
  type ExtractedField,
  type ExtractedInvoice,
  type ExtractedLineItem,
} from '../domain/invoice.js';
import { ExtractionError } from './types.js';

/**
 * Pure mapping from the prebuilt-invoice model's output to our ExtractedInvoice.
 * Field names: https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/invoice
 * Kept separate from the HTTP client so it can be unit-tested against fixtures.
 */

type Fields = Record<string, DocumentFieldOutput> | undefined;

const conf = (f: DocumentFieldOutput | undefined) =>
  typeof f?.confidence === 'number' ? round(f.confidence, 4) : null;

const round = (n: number, dp: number) => {
  const p = 10 ** dp;
  return Math.round(n * p) / p;
};

function str(f: DocumentFieldOutput | undefined): ExtractedField<string> {
  const v = (f?.valueString ?? f?.content)?.trim();
  return { value: v ? v : null, confidence: v ? conf(f) : null };
}

function date(f: DocumentFieldOutput | undefined): ExtractedField<string> {
  const v = f?.valueDate;
  // valueDate is already normalised (YYYY-MM-DD); raw `content` like "1 Nov" is not, so don't guess.
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? { value: v, confidence: conf(f) }
    : { value: null, confidence: null };
}

function amount(f: DocumentFieldOutput | undefined): ExtractedField<number> {
  const v = f?.valueCurrency?.amount ?? f?.valueNumber;
  return typeof v === 'number' && Number.isFinite(v)
    ? { value: round(v, 2), confidence: conf(f) }
    : { value: null, confidence: null };
}

function quantity(f: DocumentFieldOutput | undefined): ExtractedField<number> {
  const v = f?.valueNumber;
  return typeof v === 'number' && Number.isFinite(v)
    ? { value: round(v, 4), confidence: conf(f) }
    : { value: null, confidence: null };
}

/** Currency comes from whichever money field resolved an ISO code, most authoritative first. */
function currency(fields: Fields): ExtractedField<string> {
  for (const name of ['InvoiceTotal', 'SubTotal', 'AmountDue', 'TotalTax']) {
    const f = fields?.[name];
    const code = f?.valueCurrency?.currencyCode?.toUpperCase();
    if (code && /^[A-Z]{3}$/.test(code)) return { value: code, confidence: conf(f) };
  }
  return { value: null, confidence: null };
}

function lineItems(fields: Fields): ExtractedLineItem[] {
  const items = fields?.Items?.valueArray ?? [];
  return items.map((item) => {
    const o = item.valueObject ?? {};
    return {
      description: str(o.Description ?? o.ProductCode),
      quantity: quantity(o.Quantity),
      unitPrice: amount(o.UnitPrice),
      amount: amount(o.Amount),
    };
  });
}

export function mapAzureInvoice(result: AnalyzeResultOutput): ExtractedInvoice {
  const doc = result.documents?.[0];
  if (!doc) throw new ExtractionError('no invoice found in document', false);
  const f = doc.fields;

  const candidate: ExtractedInvoice = {
    vendorName: str(f?.VendorName ?? f?.VendorAddressRecipient),
    invoiceNumber: str(f?.InvoiceId),
    issueDate: date(f?.InvoiceDate),
    dueDate: date(f?.DueDate),
    currency: currency(f),
    subtotal: amount(f?.SubTotal),
    tax: amount(f?.TotalTax),
    total: amount(f?.InvoiceTotal ?? f?.AmountDue),
    lineItems: lineItems(f),
    modelId: `${result.modelId}@${result.apiVersion}`,
  };

  const parsed = extractedInvoiceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ExtractionError('extraction output failed validation', false, parsed.error.issues);
  }
  return parsed.data;
}
