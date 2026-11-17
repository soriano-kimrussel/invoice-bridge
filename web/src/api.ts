import type {
  AccountingStatusDto,
  ApiErrorDto,
  ApproveResponseDto,
  InvoiceDetailDto,
  InvoiceListDto,
} from '../../src/domain/api.js';
import type { InvoiceStatusValue, ReviewDraft, ReviewedInvoice } from '../../src/domain/invoice.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorDto,
  ) {
    super(body.message);
  }

  /** zod issues → { "lineItems.0.amount": "message" } */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.body.details)) {
      for (const issue of this.body.details as { path?: (string | number)[]; message: string }[]) {
        const key = (issue.path ?? []).join('.') || '_';
        out[key] ??= issue.message;
      }
    }
    return out;
  }
}

const reviewerKey = 'invoice-bridge.reviewer';
export const getReviewer = () => {
  try {
    return localStorage.getItem(reviewerKey) ?? '';
  } catch {
    return '';
  }
};
export const setReviewer = (name: string) => {
  try {
    localStorage.setItem(reviewerKey, name);
  } catch {
    /* private mode: fine */
  }
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const reviewer = getReviewer();
  if (reviewer) headers['x-reviewer'] = reviewer;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, json ?? { error: 'http_error', message: `${res.status} ${res.statusText}` });
  }
  return json as T;
}

export const api = {
  list: (status: InvoiceStatusValue[]) =>
    request<InvoiceListDto>('GET', `/api/invoices?status=${status.join(',')}&limit=200`),
  counts: () => request<Record<InvoiceStatusValue, number>>('GET', '/api/invoices/counts'),
  get: (id: string) => request<InvoiceDetailDto>('GET', `/api/invoices/${id}`),
  fileUrl: (id: string) => `/api/invoices/${id}/file`,
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ id: string; status: InvoiceStatusValue; duplicate: boolean }>('POST', '/api/invoices', fd);
  },
  saveDraft: (id: string, draft: ReviewDraft) => request<InvoiceDetailDto>('PUT', `/api/invoices/${id}/review`, draft),
  approve: (id: string, reviewed: ReviewedInvoice) =>
    request<ApproveResponseDto>('POST', `/api/invoices/${id}/approve`, reviewed),
  reject: (id: string, reason: string) => request('POST', `/api/invoices/${id}/reject`, { reason }),
  retry: (id: string) => request('POST', `/api/invoices/${id}/retry`),
  post: (id: string) => request<{ status: InvoiceStatusValue }>('POST', `/api/invoices/${id}/post`),
  reconcile: (id: string) => request<{ status: InvoiceStatusValue }>('POST', `/api/invoices/${id}/reconcile`),
  accountingStatus: () => request<AccountingStatusDto>('GET', '/api/accounting/status'),
  disconnect: () => request('POST', '/api/accounting/disconnect'),
};
