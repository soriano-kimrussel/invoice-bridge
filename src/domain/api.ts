/**
 * JSON shapes of the HTTP API, shared by the server and the React UI.
 * Dates are ISO strings on the wire.
 */
import type { ExtractedInvoice, InvoiceStatusValue, ReviewDraft } from './invoice.js';

export type InvoiceSummaryDto = {
  id: string;
  status: InvoiceStatusValue;
  originalFilename: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  total: number | null;
  currency: string | null;
  lowConfidenceCount: number;
  attempts: number;
  lastError: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceListDto = { items: InvoiceSummaryDto[]; nextCursor: string | null };

export type ReconcileResultDto = {
  ok: boolean;
  checkedAt: string;
  ours: { total: number; status: string; currency: string; invoiceNumber: string };
  theirs: { total: number | null; status: string | null; currency: string | null; invoiceNumber: string | null };
  mismatches: string[];
};

export type InvoiceDetailDto = {
  invoice: {
    id: string;
    status: InvoiceStatusValue;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    reviewedBy: string | null;
    approvedAt: string | null;
    extractedAt: string | null;
    accountingProvider: string | null;
    externalId: string | null;
    postedAt: string | null;
    reconciledAt: string | null;
    reconcileResult: ReconcileResultDto | null;
    createdAt: string;
    updatedAt: string;
  };
  extracted: ExtractedInvoice | null;
  form: ReviewDraft;
  lowConfidence: string[];
  confidenceThreshold: number;
  events: { id: string; type: string; message: string | null; createdAt: string }[];
};

export type ApproveResponseDto = {
  id: string;
  status: InvoiceStatusValue;
  alreadyApproved: boolean;
  /** Present when approval succeeded but posting to accounting did not (yet). */
  postError?: string;
};

export type AccountingStatusDto = {
  provider: string;
  configured: boolean;
  connected: boolean;
  tenantName: string | null;
  tenantId: string | null;
  accessTokenExpiresAt: string | null;
};

export type ApiErrorDto = {
  error: string;
  message: string;
  details?: unknown;
};
