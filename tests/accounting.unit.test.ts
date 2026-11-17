import { describe, expect, it, vi } from 'vitest';
import type { Invoice } from 'xero-node';
import { TokenCipher } from '../src/accounting/crypto.js';
import { compareBill } from '../src/accounting/postingService.js';
import type { TokenStore } from '../src/accounting/tokenStore.js';
import { AccountingError } from '../src/accounting/types.js';
import { allocateCents, fromXeroInvoice, toXeroBill } from '../src/accounting/xero/mapBill.js';
import { toTokens } from '../src/accounting/xero/oauthClient.js';
import {
  normalizeXeroError,
  XeroAccountingProvider,
  type XeroInvoicesApi,
} from '../src/accounting/xero/xeroProvider.js';
import { withRetry } from '../src/lib/retry.js';
import { reviewedFixture } from './helpers/fixtures.js';
import { TEST_TOKEN_KEY } from './helpers/fakeAccounting.js';

describe('toXeroBill (ReviewedInvoice → ACCPAY draft)', () => {
  it('maps header fields and tax-exclusive lines with explicit tax', () => {
    const bill = toXeroBill(reviewedFixture(), { accountCode: '400', taxType: 'INPUT' });
    expect(bill).toMatchObject({
      type: 'ACCPAY',
      status: 'DRAFT',
      contact: { name: 'Acme Supplies Pty Ltd' },
      invoiceNumber: 'INV-1001',
      date: '2026-11-01',
      dueDate: '2026-11-30',
      currencyCode: 'AUD',
      lineAmountTypes: 'Exclusive',
    });
    expect(bill.lineItems).toEqual([
      {
        description: 'Widgets',
        quantity: 10,
        unitAmount: 10,
        lineAmount: 100,
        taxAmount: 10,
        accountCode: '400',
        taxType: 'INPUT',
      },
    ]);
  });

  it('spreads tax across lines in cents so the parts sum exactly to the approved tax', () => {
    const inv = reviewedFixture({
      lineItems: [
        { description: 'A', quantity: 1, unitPrice: 33.33, amount: 33.33 },
        { description: 'B', quantity: 1, unitPrice: 33.33, amount: 33.33 },
        { description: 'C', quantity: 1, unitPrice: 33.34, amount: 33.34 },
      ],
      subtotal: 100,
      tax: 10.01,
      total: 110.01,
    });
    const lines = toXeroBill(inv, { accountCode: '400' }).lineItems!;
    const taxCents = lines.map((l) => Math.round(l.taxAmount! * 100));
    expect(taxCents.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(lines.every((l) => l.taxType === undefined)).toBe(true); // omitted → account default
  });

  it('sends 1 × amount when quantity × unit price does not multiply out to the approved line amount', () => {
    const inv = reviewedFixture({
      lineItems: [{ description: 'Freight', quantity: 3, unitPrice: 33.33, amount: 100 }],
    });
    const [line] = toXeroBill(inv, { accountCode: '400' }).lineItems!;
    expect(line).toMatchObject({ quantity: 1, unitAmount: 100, lineAmount: 100, description: 'Freight (3 × 33.33)' });
  });

  it('allocateCents handles zero weights and negative (discount) lines', () => {
    expect(allocateCents(500, [0, 0])).toEqual([500, 0]);
    expect(allocateCents(100, [1000, -200])).toEqual([125, -25]);
    expect(allocateCents(0, [])).toEqual([]);
  });

  it('reads a Xero invoice back into a provider-neutral bill', () => {
    const x = {
      invoiceID: 'abc',
      status: 'AUTHORISED',
      invoiceNumber: 'INV-1',
      contact: { name: 'Acme' },
      currencyCode: 'AUD',
      subTotal: 100,
      totalTax: 10,
      total: 110,
    } as unknown as Invoice;
    expect(fromXeroInvoice(x)).toEqual({
      externalId: 'abc',
      status: 'AUTHORISED',
      invoiceNumber: 'INV-1',
      contactName: 'Acme',
      currency: 'AUD',
      subtotal: 100,
      tax: 10,
      total: 110,
    });
  });
});

describe('compareBill (reconciliation check)', () => {
  const ours = reviewedFixture();
  const bill = {
    externalId: 'x',
    status: 'DRAFT',
    invoiceNumber: 'INV-1001',
    contactName: 'Acme Supplies Pty Ltd',
    currency: 'AUD',
    subtotal: 100,
    tax: 10,
    total: 110,
  };

  it('matches an identical draft bill', () => {
    expect(compareBill(ours, bill)).toMatchObject({ ok: true, mismatches: [] });
  });

  it.each(['SUBMITTED', 'AUTHORISED', 'PAID'])('accepts a bill that progressed to %s in Xero', (status) => {
    expect(compareBill(ours, { ...bill, status }).ok).toBe(true);
  });

  it('flags total, tax, status, currency and number differences', () => {
    const r = compareBill(ours, { ...bill, total: 110.01, tax: 10.01, status: 'VOIDED', currency: 'NZD', invoiceNumber: 'X' });
    expect(r.ok).toBe(false);
    expect(r.mismatches.join('\n')).toMatch(/total: ours 110.00, theirs 110.01/);
    expect(r.mismatches.join('\n')).toMatch(/status: bill is VOIDED/);
    expect(r.mismatches).toHaveLength(5);
  });

  it('is not fooled by floating point (0.1 + 0.2)', () => {
    const r = compareBill(reviewedFixture({ total: 0.3, subtotal: 0.3, tax: 0, lineItems: [{ description: 'x', quantity: 1, unitPrice: 0.3, amount: 0.3 }] }), {
      ...bill,
      total: 0.1 + 0.2,
      subtotal: 0.30000000000000004,
      tax: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('reports a missing bill', () => {
    expect(compareBill(ours, null).mismatches).toEqual(['bill not found in the accounting system (deleted?)']);
  });
});

describe('TokenCipher', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const c = new TokenCipher(TEST_TOKEN_KEY);
    const a = c.encrypt('secret-refresh-token');
    const b = c.encrypt('secret-refresh-token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret');
    expect(c.decrypt(a)).toBe('secret-refresh-token');
  });

  it('detects tampering and wrong keys', () => {
    const c = new TokenCipher(TEST_TOKEN_KEY);
    const enc = c.encrypt('x');
    const parts = enc.split('.');
    parts[3] = Buffer.from('y').toString('base64url');
    expect(() => c.decrypt(parts.join('.'))).toThrow();
    expect(() => new TokenCipher(Buffer.alloc(32, 1).toString('base64')).decrypt(enc)).toThrow();
    expect(() => new TokenCipher('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});

describe('toTokens', () => {
  it('requires a refresh token (offline_access) and computes expiry', () => {
    const t = toTokens({ access_token: 'a', refresh_token: 'r', expires_at: 2_000_000_000, scope: 's' } as never);
    expect(t.expiresAt.toISOString()).toBe(new Date(2_000_000_000_000).toISOString());
    expect(() => toTokens({ access_token: 'a' } as never)).toThrow(/offline_access/);
  });
});

describe('normalizeXeroError', () => {
  it('parses the JSON string xero-node rejects with, including validation errors', () => {
    const raw = JSON.stringify({
      response: { statusCode: 400, headers: {} },
      body: { Elements: [{ ValidationErrors: [{ Message: 'Account code 999 is not valid' }] }] },
    });
    expect(normalizeXeroError(raw)).toMatchObject({ status: 400, message: 'Account code 999 is not valid' });
  });

  it('reads Retry-After on 429', () => {
    const f = normalizeXeroError({ response: { statusCode: 429, headers: { 'retry-after': '7' } }, body: { Title: 'Rate limit' } });
    expect(f).toMatchObject({ status: 429, retryAfterMs: 7000, message: 'Rate limit' });
  });

  it('handles plain errors', () => {
    expect(normalizeXeroError(new Error('ECONNRESET'))).toMatchObject({ status: undefined, message: 'ECONNRESET' });
  });
});

describe('XeroAccountingProvider (Xero API mocked)', () => {
  const grant = { accessToken: 'tok-1', tenantId: 'tenant-demo' };
  const tokens = () =>
    ({
      getAccessToken: vi.fn(async () => grant),
      refreshAfterUnauthorized: vi.fn(async () => ({ ...grant, accessToken: 'tok-2' })),
    }) as unknown as TokenStore & {
      getAccessToken: ReturnType<typeof vi.fn>;
      refreshAfterUnauthorized: ReturnType<typeof vi.fn>;
    };
  const xeroErr = (status: number, headers: Record<string, string> = {}) =>
    JSON.stringify({ response: { statusCode: status, headers }, body: { Message: `HTTP ${status}` } });
  const created = { invoiceID: 'xero-bill-1', status: 'DRAFT', total: 110 } as unknown as Invoice;

  function api(overrides: Partial<XeroInvoicesApi> = {}): XeroInvoicesApi {
    return {
      createBill: vi.fn(async () => created),
      getInvoice: vi.fn(async () => created),
      findOwnBills: vi.fn(async () => []),
      ...overrides,
    };
  }
  const sleep = vi.fn(async () => {});
  const opts = { accountCode: '400', retry: { attempts: 3, baseMs: 10, maxMs: 100 }, sleep };

  it('passes the idempotency key and the mapped ACCPAY bill to Xero', async () => {
    const a = api();
    const p = new XeroAccountingProvider(tokens(), a, opts);
    const bill = await p.createBill({ idempotencyKey: 'our-invoice-id', invoice: reviewedFixture() });
    expect(bill.externalId).toBe('xero-bill-1');
    expect(a.createBill).toHaveBeenCalledWith(grant, expect.objectContaining({ type: 'ACCPAY', status: 'DRAFT' }), 'our-invoice-id');
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    let n = 0;
    const a = api({
      createBill: vi.fn(async () => {
        if (++n === 1) throw xeroErr(429, { 'retry-after': '2' });
        return created;
      }),
    });
    sleep.mockClear();
    await new XeroAccountingProvider(tokens(), a, opts).createBill({ idempotencyKey: 'k', invoice: reviewedFixture() });
    expect(a.createBill).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100); // Retry-After 2000ms capped by maxMs 100
  });

  it('does not retry a 400 validation error', async () => {
    const a = api({ createBill: vi.fn(async () => Promise.reject(xeroErr(400))) });
    const err = await new XeroAccountingProvider(tokens(), a, opts)
      .createBill({ idempotencyKey: 'k', invoice: reviewedFixture() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).retryable).toBe(false);
    expect(a.createBill).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts on persistent 503', async () => {
    const a = api({ getInvoice: vi.fn(async () => Promise.reject(xeroErr(503))) });
    await expect(new XeroAccountingProvider(tokens(), a, opts).getBill('x')).rejects.toMatchObject({ retryable: true, status: 503 });
    expect(a.getInvoice).toHaveBeenCalledTimes(3);
  });

  it('on 401 forces one token refresh and retries with the new token', async () => {
    const t = tokens();
    let n = 0;
    const a = api({
      getInvoice: vi.fn(async () => {
        if (++n === 1) throw xeroErr(401);
        return created;
      }),
    });
    t.getAccessToken.mockResolvedValueOnce(grant).mockResolvedValueOnce({ ...grant, accessToken: 'tok-2' });
    await new XeroAccountingProvider(t, a, opts).getBill('xero-bill-1');
    expect(t.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(a.getInvoice).toHaveBeenLastCalledWith({ ...grant, accessToken: 'tok-2' }, 'xero-bill-1');
  });

  it('findOwnBill matches supplier name case-insensitively and exact invoice number', async () => {
    const a = api({
      findOwnBills: vi.fn(async () => [
        { invoiceID: '1', invoiceNumber: 'INV-1001', contact: { name: 'Someone Else' }, status: 'DRAFT' },
        { invoiceID: '2', invoiceNumber: 'INV-1001', contact: { name: 'ACME SUPPLIES PTY LTD' }, status: 'DRAFT' },
      ] as unknown as Invoice[]),
    });
    const found = await new XeroAccountingProvider(tokens(), a, opts).findOwnBill({
      contactName: 'Acme Supplies Pty Ltd',
      invoiceNumber: 'INV-1001',
    });
    expect(found?.externalId).toBe('2');
  });
});

describe('withRetry', () => {
  it('stops retrying on a non-retryable error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(withRetry(fn, { attempts: 5, baseMs: 1, maxMs: 1, isRetryable: () => false })).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
