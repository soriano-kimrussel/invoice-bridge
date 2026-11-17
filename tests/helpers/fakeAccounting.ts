import { randomUUID } from 'node:crypto';
import { AccountingError, type AccountingProvider, type BillInput, type ExternalBill } from '../../src/accounting/types.js';
import type { OAuthClient, OAuthTokens } from '../../src/accounting/tokenStore.js';
import { InvalidGrantError } from '../../src/accounting/tokenStore.js';

/**
 * In-memory stand-in for Xero's bills API. Records every create call so tests
 * can assert "exactly one bill", and lets tests inject failures and latency.
 */
export class FakeAccountingProvider implements AccountingProvider {
  readonly name = 'xero';
  readonly bills = new Map<string, ExternalBill & { idempotencyKey: string; createdByApp: boolean }>();
  createCalls: BillInput[] = [];
  createDelayMs = 0;
  /** Return an error to make the next createBill fail. Called per attempt. */
  failCreate: ((n: number) => Error | undefined) | undefined;
  failGet: Error | undefined;
  /** Simulates: bill created in Xero, then our process died before storing the id. */
  crashAfterCreate = false;

  async createBill(input: BillInput): Promise<ExternalBill> {
    this.createCalls.push(input);
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const err = this.failCreate?.(this.createCalls.length);
    if (err) throw err;
    const inv = input.invoice;
    const bill = {
      externalId: randomUUID(),
      status: 'DRAFT',
      invoiceNumber: inv.invoiceNumber,
      contactName: inv.vendorName,
      currency: inv.currency,
      subtotal: inv.subtotal,
      tax: inv.tax,
      total: inv.total,
      idempotencyKey: input.idempotencyKey,
      createdByApp: true,
    };
    this.bills.set(bill.externalId, bill);
    if (this.crashAfterCreate) {
      this.crashAfterCreate = false;
      throw new AccountingError('socket hang up after request was sent', true);
    }
    return strip(bill);
  }

  async findOwnBill(q: { contactName: string; invoiceNumber: string }): Promise<ExternalBill | null> {
    const b = [...this.bills.values()].find(
      (x) =>
        x.createdByApp &&
        x.invoiceNumber === q.invoiceNumber &&
        x.contactName?.toLowerCase() === q.contactName.toLowerCase() &&
        !['VOIDED', 'DELETED'].includes(x.status),
    );
    return b ? strip(b) : null;
  }

  async getBill(externalId: string): Promise<ExternalBill | null> {
    if (this.failGet) throw this.failGet;
    const b = this.bills.get(externalId);
    return b ? strip(b) : null;
  }

  /** Simulate someone editing the bill in Xero after we posted it. */
  tamper(externalId: string, patch: Partial<ExternalBill>) {
    const b = this.bills.get(externalId);
    if (!b) throw new Error('no such bill');
    Object.assign(b, patch);
  }
}

function strip(b: ExternalBill & { idempotencyKey: string; createdByApp: boolean }): ExternalBill {
  const { idempotencyKey: _k, createdByApp: _c, ...rest } = b;
  return rest;
}

/** Fake OAuth server issuing numbered, rotating tokens. */
export class FakeOAuthClient implements OAuthClient {
  refreshCalls: string[] = [];
  refreshDelayMs = 0;
  invalidGrant = false;
  private n = 0;
  constructor(private readonly ttlMs = 30 * 60_000) {}

  issue(): OAuthTokens {
    this.n++;
    return {
      accessToken: `access-${this.n}`,
      refreshToken: `refresh-${this.n}`,
      expiresAt: new Date(Date.now() + this.ttlMs),
      scope: 'openid offline_access accounting.invoices',
    };
  }

  async consentUrl(state: string) {
    return `https://login.xero.test/authorize?state=${state}`;
  }

  async exchangeCode(_url: string, _state: string) {
    return { tokens: this.issue(), tenants: [{ tenantId: 'tenant-demo', tenantName: 'Demo Company (AU)' }] };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    this.refreshCalls.push(refreshToken);
    if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.invalidGrant) throw new InvalidGrantError();
    // Rotating refresh tokens: only the latest one is valid.
    if (refreshToken !== `refresh-${this.n}`) throw new InvalidGrantError('refresh token already used');
    return this.issue();
  }
}

export const TEST_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
