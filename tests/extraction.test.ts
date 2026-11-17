import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lowConfidenceFields } from '../src/domain/invoice.js';
import { mapAzureInvoice } from '../src/extraction/mapAzureInvoice.js';
import { ExtractionError, isRetryableStatus } from '../src/extraction/types.js';
import { backoffMs } from '../src/worker/backoff.js';
import { azureInvoiceResult } from './helpers/azureFixtures.js';
import { fakePdf } from './helpers/fixtures.js';

// Mock the Azure SDK module: no test ever reaches the live service.
const pollUntilDone = vi.fn();
vi.mock('@azure-rest/ai-document-intelligence', () => ({
  default: vi.fn(() => {
    throw new Error('tests must inject a fake client');
  }),
  getLongRunningPoller: vi.fn(() => ({ pollUntilDone })),
  isUnexpected: (r: { status: string }) => !['200', '202'].includes(r.status),
}));

const { AzureInvoiceExtractor } = await import('../src/extraction/azure.js');

function fakeClient(initial: { status: string; body?: unknown } | Error) {
  const post = vi.fn(async () => {
    if (initial instanceof Error) throw initial;
    return { headers: { 'operation-location': 'https://x/op/1' }, body: {}, ...initial };
  });
  const path = vi.fn(() => ({ post }));
  // Only `.path()` is used by the extractor.
  return { client: { path } as never, path, post };
}

describe('mapAzureInvoice', () => {
  it('maps prebuilt-invoice fields with per-field confidence', () => {
    const ex = mapAzureInvoice(azureInvoiceResult());
    expect(ex).toMatchObject({
      vendorName: { value: 'Acme Supplies Pty Ltd', confidence: 0.981 },
      invoiceNumber: { value: 'INV-1001', confidence: 0.973 },
      issueDate: { value: '2026-11-01' },
      dueDate: { value: '2026-11-30', confidence: 0.612 },
      currency: { value: 'AUD', confidence: 0.99 },
      subtotal: { value: 100 },
      tax: { value: 10 },
      total: { value: 110, confidence: 0.99 },
      modelId: 'prebuilt-invoice@2024-11-30',
    });
    expect(ex.lineItems).toEqual([
      {
        description: { value: 'Widgets', confidence: 0.93 },
        quantity: { value: 10, confidence: 0.92 },
        unitPrice: { value: 10, confidence: 0.5 },
        amount: { value: 100, confidence: 0.94 },
      },
    ]);
    expect(lowConfidenceFields(ex, 0.8).sort()).toEqual(['dueDate', 'lineItems.0.unitPrice']);
  });

  it('turns missing fields into null value + null confidence instead of guessing', () => {
    const ex = mapAzureInvoice(
      azureInvoiceResult({
        DueDate: undefined,
        TotalTax: undefined,
        InvoiceDate: { type: 'date', content: 'sometime in Nov', confidence: 0.4 }, // no valueDate
      }),
    );
    expect(ex.dueDate).toEqual({ value: null, confidence: null });
    expect(ex.tax).toEqual({ value: null, confidence: null });
    expect(ex.issueDate).toEqual({ value: null, confidence: null });
  });

  it('rounds money to cents and leaves currency null when no ISO code was resolved', () => {
    const noCode = { type: 'currency', valueCurrency: { amount: 110.004999 }, confidence: 0.9 };
    const ex = mapAzureInvoice(
      azureInvoiceResult({ InvoiceTotal: noCode, SubTotal: noCode, TotalTax: noCode }),
    );
    expect(ex.total.value).toBe(110);
    expect(ex.currency.value).toBeNull();
  });

  it('fails non-retryably when the document has no invoice', () => {
    const empty = { ...azureInvoiceResult(), documents: [] };
    expect(() => mapAzureInvoice(empty)).toThrow(ExtractionError);
    try {
      mapAzureInvoice(empty);
    } catch (e) {
      expect((e as ExtractionError).retryable).toBe(false);
    }
  });

  it('fails non-retryably when the output does not validate (zod)', () => {
    const bad = azureInvoiceResult({
      InvoiceTotal: { type: 'currency', valueCurrency: { amount: 1, currencyCode: 'AUD' }, confidence: 7 },
    });
    expect(() => mapAzureInvoice(bad)).toThrow(/failed validation/);
  });
});

describe('AzureInvoiceExtractor (SDK mocked)', () => {
  beforeEach(() => {
    pollUntilDone.mockReset();
  });

  const opts = { endpoint: 'https://example.cognitiveservices.azure.com/', key: 'test-key', pollIntervalMs: 1 };

  it('posts the bytes to prebuilt-invoice and maps the polled result', async () => {
    const { client, path, post } = fakeClient({ status: '202' });
    pollUntilDone.mockResolvedValue({
      status: '200',
      body: { status: 'succeeded', analyzeResult: azureInvoiceResult() },
    });
    const ex = await new AzureInvoiceExtractor(opts, client).extract(fakePdf(), 'application/pdf');
    expect(path).toHaveBeenCalledWith('/documentModels/{modelId}:analyze', 'prebuilt-invoice');
    expect(post).toHaveBeenCalledWith({ contentType: 'application/pdf', body: fakePdf() });
    expect(ex.total.value).toBe(110);
  });

  it.each([
    ['429', true],
    ['503', true],
    ['400', false],
    ['401', false],
  ])('classifies an initial HTTP %s as retryable=%s', async (status, retryable) => {
    const { client } = fakeClient({ status, body: { error: { code: 'X', message: 'nope' } } });
    const err = await new AzureInvoiceExtractor(opts, client)
      .extract(fakePdf(), 'application/pdf')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).retryable).toBe(retryable);
  });

  it('treats network errors as retryable', async () => {
    const { client } = fakeClient(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    const err = (await new AzureInvoiceExtractor(opts, client)
      .extract(fakePdf(), 'application/pdf')
      .catch((e: unknown) => e)) as ExtractionError;
    expect(err.retryable).toBe(true);
  });

  it('treats an analysis that failed on bad content as non-retryable', async () => {
    const { client } = fakeClient({ status: '202' });
    pollUntilDone.mockResolvedValue({
      status: '200',
      body: { status: 'failed', error: { code: 'InvalidContent', message: 'corrupt' } },
    });
    const err = (await new AzureInvoiceExtractor(opts, client)
      .extract(fakePdf(), 'application/pdf')
      .catch((e: unknown) => e)) as ExtractionError;
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/InvalidContent/);
  });

  it('times out a stuck analysis as retryable', async () => {
    const { client } = fakeClient({ status: '202' });
    pollUntilDone.mockReturnValue(new Promise(() => {}));
    const err = (await new AzureInvoiceExtractor({ ...opts, timeoutMs: 20 }, client)
      .extract(fakePdf(), 'application/pdf')
      .catch((e: unknown) => e)) as ExtractionError;
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/did not finish/);
  });

  it('rejects unsupported content types without calling Azure', async () => {
    const { client, post } = fakeClient({ status: '202' });
    await expect(new AzureInvoiceExtractor(opts, client).extract(fakePdf(), 'text/plain')).rejects.toThrow(
      /unsupported/,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe('retry policy', () => {
  it('classifies HTTP statuses', () => {
    expect([undefined, 408, 429, 500, 503].map(isRetryableStatus)).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404, 415].map(isRetryableStatus)).toEqual([false, false, false, false, false]);
  });

  it('backs off exponentially with jitter between 50% and 100%, capped', () => {
    const opts = { baseMs: 1000, maxMs: 30_000 };
    expect([1, 2, 3, 4].map((n) => backoffMs(n, opts, () => 1))).toEqual([1000, 2000, 4000, 8000]);
    expect([1, 2, 3, 4].map((n) => backoffMs(n, opts, () => 0))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffMs(20, opts, () => 1)).toBe(30_000);
  });
});
