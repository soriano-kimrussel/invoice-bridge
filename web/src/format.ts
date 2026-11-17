import type { InvoiceStatusValue } from '../../src/domain/invoice.js';

export const STATUS_LABEL: Record<InvoiceStatusValue, string> = {
  pending: 'Queued',
  processing: 'Extracting',
  needs_review: 'Needs review',
  approved: 'Approved',
  submitted: 'Sent to Xero',
  posted: 'Posted',
  mismatch: 'Mismatch',
  rejected: 'Rejected',
  failed: 'Failed',
};

export function money(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

export function when(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString();
}

export const pct = (c: number | null | undefined) => (c === null || c === undefined ? '?' : `${Math.round(c * 100)}%`);
