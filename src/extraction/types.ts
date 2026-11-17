import type { ExtractedInvoice } from '../domain/invoice.js';

/** The extraction boundary: bytes in, validated ExtractedInvoice out. */
export interface InvoiceExtractor {
  readonly name: string;
  extract(file: Buffer, mimeType: string): Promise<ExtractedInvoice>;
}

/**
 * Thrown by extractors. `retryable` decides whether the worker backs off and
 * tries again (throttling, outages, timeouts) or fails the invoice straight
 * away (corrupt file, unsupported content, output that fails validation).
 */
export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/** HTTP status → retryable? 408/429/5xx are transient; other 4xx mean the request itself is wrong. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network error, no response
  return status === 408 || status === 429 || status >= 500;
}
