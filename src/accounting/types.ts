import type { ReviewedInvoice } from '../domain/invoice.js';

/**
 * The accounting boundary. Everything Xero-specific lives behind this
 * interface; a MYOB (or QuickBooks) provider would implement the same three
 * methods and nothing else in the app would change.
 */
export interface AccountingProvider {
  readonly name: string;
  /**
   * Create a draft accounts-payable bill. `idempotencyKey` is our invoice id:
   * providers that support idempotency keys must pass it through.
   */
  createBill(input: BillInput): Promise<ExternalBill>;
  /**
   * Find a bill this app already created for the same supplier invoice, used
   * to recover when a previous attempt created the bill but crashed before we
   * stored its id.
   */
  findOwnBill(query: { contactName: string; invoiceNumber: string }): Promise<ExternalBill | null>;
  /** Re-read a bill for reconciliation. Null if it no longer exists. */
  getBill(externalId: string): Promise<ExternalBill | null>;
}

export type BillInput = { idempotencyKey: string; invoice: ReviewedInvoice };

/** Provider-neutral view of a bill, enough to reconcile against. */
export type ExternalBill = {
  externalId: string;
  /** Provider status, upper-case (Xero: DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, DELETED). */
  status: string;
  invoiceNumber: string | null;
  contactName: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
};

export class AccountingError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AccountingError';
  }
}

/** No usable connection: never authorised, disconnected, or the refresh token was revoked. */
export class NotConnectedError extends AccountingError {
  constructor(message = 'not connected to the accounting system') {
    super(message, false, 401);
    this.name = 'NotConnectedError';
  }
}
