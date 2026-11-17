import { XeroClient, type Invoice } from 'xero-node';
import { withRetry } from '../../lib/retry.js';
import type { AccessGrant, TokenStore } from '../tokenStore.js';
import { AccountingError, type AccountingProvider, type BillInput, type ExternalBill } from '../types.js';
import { fromXeroInvoice, toXeroBill, type BillMappingOptions } from './mapBill.js';

/**
 * The three Xero Accounting API calls we use, with the access token passed
 * explicitly. This is the seam tests mock: no test talks to Xero.
 */
export interface XeroInvoicesApi {
  createBill(grant: AccessGrant, bill: Invoice, idempotencyKey: string): Promise<Invoice>;
  getInvoice(grant: AccessGrant, invoiceId: string): Promise<Invoice | null>;
  findOwnBills(grant: AccessGrant, invoiceNumber: string): Promise<Invoice[]>;
}

/** Normalised view of whatever xero-node rejected with. */
export type XeroFailure = { status?: number; message: string; retryAfterMs?: number; body?: unknown };

export function normalizeXeroError(err: unknown): XeroFailure {
  let e: unknown = err;
  if (typeof e === 'string') {
    try {
      e = JSON.parse(e); // xero-node rejects with JSON.stringify(ApiError.generateError())
    } catch {
      return { message: e as string };
    }
  }
  const any = e as {
    message?: string;
    statusCode?: number;
    response?: { statusCode?: number; status?: number; headers?: Record<string, string> };
    body?: {
      Message?: string;
      Detail?: string;
      Title?: string;
      Elements?: { ValidationErrors?: { Message?: string }[] }[];
    };
  };
  const status = any?.response?.statusCode ?? any?.response?.status ?? any?.statusCode;
  const validation = any?.body?.Elements?.flatMap((el) => el.ValidationErrors ?? [])
    .map((v) => v.Message)
    .filter(Boolean);
  const message =
    (validation?.length ? validation.join('; ') : undefined) ??
    any?.body?.Detail ??
    any?.body?.Message ??
    any?.body?.Title ??
    any?.message ??
    'unknown Xero error';
  const retryAfter = Number(any?.response?.headers?.['retry-after']);
  return {
    status,
    message,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    body: any?.body,
  };
}

const isRetryableStatus = (s?: number) => s === undefined || s === 408 || s === 429 || s >= 500;

/** Real implementation on top of xero-node's AccountingApi. */
export class XeroNodeInvoicesApi implements XeroInvoicesApi {
  private readonly xero = new XeroClient();

  private use(grant: AccessGrant) {
    this.xero.setTokenSet({ access_token: grant.accessToken, token_type: 'Bearer' });
    return this.xero.accountingApi;
  }

  async createBill(grant: AccessGrant, bill: Invoice, idempotencyKey: string): Promise<Invoice> {
    const res = await this.use(grant).createInvoices(grant.tenantId, { invoices: [bill] }, true, 4, idempotencyKey);
    const created = res.body.invoices?.[0];
    if (!created?.invoiceID) throw new AccountingError('Xero did not return an InvoiceID', true);
    return created;
  }

  async getInvoice(grant: AccessGrant, invoiceId: string): Promise<Invoice | null> {
    try {
      const res = await this.use(grant).getInvoice(grant.tenantId, invoiceId, 4);
      return res.body.invoices?.[0] ?? null;
    } catch (err) {
      if (normalizeXeroError(err).status === 404) return null;
      throw err;
    }
  }

  async findOwnBills(grant: AccessGrant, invoiceNumber: string): Promise<Invoice[]> {
    const res = await this.use(grant).getInvoices(
      grant.tenantId,
      undefined,
      'Type=="ACCPAY"',
      undefined,
      undefined,
      [invoiceNumber],
      undefined,
      ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'],
      1,
      false,
      true, // createdByMyApp: only bills this app made
      4,
    );
    return res.body.invoices ?? [];
  }
}

export type XeroProviderOptions = BillMappingOptions & {
  retry?: { attempts: number; baseMs: number; maxMs: number };
  sleep?: (ms: number) => Promise<void>;
};

/** AccountingProvider for Xero: draft ACCPAY bills, OAuth2 tokens from the TokenStore. */
export class XeroAccountingProvider implements AccountingProvider {
  readonly name = 'xero';

  constructor(
    private readonly tokens: TokenStore,
    private readonly api: XeroInvoicesApi,
    private readonly opts: XeroProviderOptions,
  ) {}

  createBill({ idempotencyKey, invoice }: BillInput): Promise<ExternalBill> {
    const bill = toXeroBill(invoice, this.opts);
    return this.call('create bill', async (g) => fromXeroInvoice(await this.api.createBill(g, bill, idempotencyKey)));
  }

  async findOwnBill(q: { contactName: string; invoiceNumber: string }): Promise<ExternalBill | null> {
    const found = await this.call('find bill', (g) => this.api.findOwnBills(g, q.invoiceNumber));
    const match = found
      .map(fromXeroInvoice)
      .find(
        (b) =>
          b.invoiceNumber === q.invoiceNumber &&
          (b.contactName ?? '').trim().toLowerCase() === q.contactName.trim().toLowerCase(),
      );
    return match ?? null;
  }

  getBill(externalId: string): Promise<ExternalBill | null> {
    return this.call('get bill', async (g) => {
      const x = await this.api.getInvoice(g, externalId);
      return x ? fromXeroInvoice(x) : null;
    });
  }

  /**
   * Every API call: valid token (refreshed before expiry), retried with
   * backoff on 429/5xx (honouring Retry-After), and one forced token refresh
   * if Xero answers 401 anyway (e.g. token revoked early).
   */
  private async call<T>(what: string, fn: (grant: AccessGrant) => Promise<T>): Promise<T> {
    const retry = this.opts.retry ?? { attempts: 4, baseMs: 1000, maxMs: 30_000 };
    let refreshedAfter401 = false;
    try {
      return await withRetry(
        async () => {
          const grant = await this.tokens.getAccessToken();
          try {
            return await fn(grant);
          } catch (err) {
            if (err instanceof AccountingError) throw err;
            const f = normalizeXeroError(err);
            if (f.status === 401 && !refreshedAfter401) {
              refreshedAfter401 = true;
              await this.tokens.refreshAfterUnauthorized();
              return await fn(await this.tokens.getAccessToken());
            }
            throw new AccountingError(`Xero ${what} failed (${f.status ?? 'network'}): ${f.message}`, isRetryableStatus(f.status), f.status, {
              ...f,
              retryAfterMs: f.retryAfterMs,
            });
          }
        },
        {
          ...retry,
          sleep: this.opts.sleep,
          isRetryable: (e) => e instanceof AccountingError && e.retryable,
          retryAfterMs: (e) => ((e as AccountingError).details as XeroFailure | undefined)?.retryAfterMs,
        },
      );
    } catch (err) {
      if (err instanceof AccountingError) throw err;
      const f = normalizeXeroError(err);
      throw new AccountingError(`Xero ${what} failed: ${f.message}`, isRetryableStatus(f.status), f.status);
    }
  }
}
