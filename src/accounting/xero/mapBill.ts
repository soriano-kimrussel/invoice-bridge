import { Invoice, LineAmountTypes, type CurrencyCode, type LineItem } from 'xero-node';
import { toCents, type ReviewedInvoice } from '../../domain/invoice.js';
import type { ExternalBill } from '../types.js';

export type BillMappingOptions = { accountCode: string; taxType?: string };

/**
 * ReviewedInvoice → Xero draft bill (Invoice, Type ACCPAY). Pure.
 *
 * Amounts are tax-exclusive. Our reviewed tax is spread over the lines in
 * integer cents and sent as each line's TaxAmount, so the bill Xero computes
 * (SubTotal + TotalTax) equals the total the reviewer approved rather than
 * whatever the account's default tax rate would produce. Reconciliation then
 * proves it.
 */
export function toXeroBill(inv: ReviewedInvoice, opts: BillMappingOptions): Invoice {
  const amounts = inv.lineItems.map((li) => toCents(li.amount));
  const taxes = allocateCents(toCents(inv.tax), amounts);

  const lineItems: LineItem[] = inv.lineItems.map((li, i) => {
    const amountCents = amounts[i]!;
    // Xero computes LineAmount = Quantity × UnitAmount. If the document's line doesn't
    // multiply out exactly, send it as 1 × amount so Xero's figure matches the approved one.
    const exact = Math.round(li.quantity * toCents(li.unitPrice)) === amountCents;
    return {
      description: exact ? li.description : `${li.description} (${li.quantity} × ${li.unitPrice})`,
      quantity: exact ? li.quantity : 1,
      unitAmount: exact ? li.unitPrice : amountCents / 100,
      lineAmount: amountCents / 100,
      taxAmount: taxes[i]! / 100,
      accountCode: opts.accountCode,
      ...(opts.taxType ? { taxType: opts.taxType } : {}),
    };
  });

  return {
    type: Invoice.TypeEnum.ACCPAY,
    status: Invoice.StatusEnum.DRAFT,
    contact: { name: inv.vendorName },
    invoiceNumber: inv.invoiceNumber,
    date: inv.issueDate,
    dueDate: inv.dueDate,
    currencyCode: inv.currency as unknown as CurrencyCode,
    lineAmountTypes: LineAmountTypes.Exclusive,
    lineItems,
  };
}

/**
 * Split `total` cents across lines proportionally to `weights`, rounding each
 * share and giving the remainder to the last line so the parts sum exactly.
 */
export function allocateCents(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const shares = weights.map((w) => Math.round((total * w) / sum));
  const allocated = shares.slice(0, -1).reduce((a, b) => a + b, 0);
  shares[shares.length - 1] = total - allocated;
  return shares;
}

/** Xero Invoice → provider-neutral bill. */
export function fromXeroInvoice(x: Invoice): ExternalBill {
  return {
    externalId: x.invoiceID ?? '',
    status: String(x.status ?? '').toUpperCase(),
    invoiceNumber: x.invoiceNumber ?? null,
    contactName: x.contact?.name ?? null,
    currency: x.currencyCode ? String(x.currencyCode) : null,
    subtotal: typeof x.subTotal === 'number' ? x.subTotal : null,
    tax: typeof x.totalTax === 'number' ? x.totalTax : null,
    total: typeof x.total === 'number' ? x.total : null,
  };
}
