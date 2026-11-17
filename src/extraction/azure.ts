import DocumentIntelligence, {
  getLongRunningPoller,
  isUnexpected,
  type AnalyzeOperationOutput,
  type DocumentIntelligenceClient,
} from '@azure-rest/ai-document-intelligence';
import type { ExtractedInvoice } from '../domain/invoice.js';
import { mapAzureInvoice } from './mapAzureInvoice.js';
import { ExtractionError, isRetryableStatus, type InvoiceExtractor } from './types.js';

export const PREBUILT_INVOICE_MODEL = 'prebuilt-invoice';

type AzureContentType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/tiff' | 'image/bmp';
const SUPPORTED = new Set<string>(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/bmp']);

export type AzureExtractorOptions = {
  endpoint: string;
  key: string;
  /** Poll interval for the long-running analyze operation. */
  pollIntervalMs?: number;
  /** Give up waiting for one analysis after this long (it is retried later). */
  timeoutMs?: number;
};

/** Azure AI Document Intelligence, prebuilt invoice model, via the official REST-level SDK. */
export class AzureInvoiceExtractor implements InvoiceExtractor {
  readonly name = 'azure-document-intelligence';
  private readonly client: DocumentIntelligenceClient;

  constructor(
    private readonly options: AzureExtractorOptions,
    client?: DocumentIntelligenceClient,
  ) {
    this.client = client ?? DocumentIntelligence(options.endpoint, { key: options.key });
  }

  async extract(file: Buffer, mimeType: string): Promise<ExtractedInvoice> {
    if (!SUPPORTED.has(mimeType)) {
      throw new ExtractionError(`unsupported content type ${mimeType}`, false);
    }

    let operation: AnalyzeOperationOutput;
    try {
      const initial = await this.client
        .path('/documentModels/{modelId}:analyze', PREBUILT_INVOICE_MODEL)
        .post({ contentType: mimeType as AzureContentType, body: file });

      if (isUnexpected(initial)) {
        const status = Number(initial.status);
        const err = initial.body.error;
        throw new ExtractionError(
          `Document Intelligence rejected the request (${status} ${err?.code ?? ''}): ${err?.message ?? 'unknown error'}`,
          isRetryableStatus(status),
          { status, code: err?.code },
        );
      }

      const poller = getLongRunningPoller(this.client, initial, {
        intervalInMs: this.options.pollIntervalMs ?? 1000,
      });
      const done = await withTimeout(poller.pollUntilDone(), this.options.timeoutMs ?? 120_000);
      if (isUnexpected(done)) {
        const status = Number(done.status);
        throw new ExtractionError(
          `analysis polling failed (${status}): ${done.body.error?.message ?? 'unknown error'}`,
          isRetryableStatus(status),
        );
      }
      operation = done.body as AnalyzeOperationOutput;
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      // RestError / network errors carry an optional statusCode.
      const status = (err as { statusCode?: number }).statusCode;
      throw new ExtractionError(
        `Document Intelligence call failed: ${(err as Error).message}`,
        isRetryableStatus(status),
      );
    }

    if (operation.status !== 'succeeded' || !operation.analyzeResult) {
      const e = operation.error;
      // A failed analysis with InternalServerError is transient; InvalidContent etc. is not.
      const retryable = !e?.code || /internal|timeout|unavailable/i.test(e.code);
      throw new ExtractionError(
        `analysis ${operation.status}: ${e?.code ?? ''} ${e?.message ?? ''}`.trim(),
        retryable,
        e,
      );
    }

    return mapAzureInvoice(operation.analyzeResult);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExtractionError(`analysis did not finish within ${ms} ms`, true)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
