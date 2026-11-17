import { createHash } from 'node:crypto';
import { Prisma, type Db, type Invoice, type InvoiceStatus } from '../db.js';
import {
  INVOICE_STATUSES,
  extractedInvoiceSchema,
  lowConfidenceFields,
  mergeForReview,
  reviewDraftSchema,
  reviewedInvoiceSchema,
  type ExtractedInvoice,
  type ReviewDraft,
  type ReviewedInvoice,
} from '../domain/invoice.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../errors.js';
import type { FileStorage } from '../storage/types.js';
import { detectFileType, SUPPORTED_DESCRIPTION } from './fileType.js';

export type UploadInput = { data: Buffer; filename: string };
export type UploadResult = { invoice: Invoice; duplicate: boolean };

export type InvoiceSummary = {
  id: string;
  status: InvoiceStatus;
  originalFilename: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  total: number | null;
  currency: string | null;
  lowConfidenceCount: number;
  attempts: number;
  lastError: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InvoiceDetail = {
  invoice: Omit<Invoice, 'extracted' | 'reviewed'>;
  extracted: ExtractedInvoice | null;
  /** Values to show in the edit form: saved draft, else extraction. */
  form: ReviewDraft;
  lowConfidence: string[];
  confidenceThreshold: number;
  events: { id: string; type: string; message: string | null; createdAt: Date }[];
};

const REVIEWABLE: InvoiceStatus[] = ['needs_review'];
const ALREADY_APPROVED: InvoiceStatus[] = ['approved', 'submitted', 'posted', 'mismatch'];

export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
    private readonly options: { confidenceThreshold: number; maxAttempts?: number },
  ) {}

  // ---------------------------------------------------------------------------
  // Upload (idempotent on content hash)
  // ---------------------------------------------------------------------------

  async upload({ data, filename }: UploadInput): Promise<UploadResult> {
    if (data.length === 0) throw badRequest('file is empty');
    const type = detectFileType(data);
    if (!type) {
      throw new AppError(415, 'unsupported_file', `unsupported file type; expected ${SUPPORTED_DESCRIPTION}`);
    }

    const contentHash = createHash('sha256').update(data).digest('hex');
    const existing = await this.db.invoice.findUnique({ where: { contentHash } });
    if (existing) return { invoice: existing, duplicate: true };

    // Store the file before the row exists, so a worker can never claim a row whose file is missing.
    // Keys are content-addressed, so concurrent uploads of the same file write the same object.
    const storageKey = `${contentHash}.${type.ext}`;
    await this.storage.put(storageKey, data, type.mimeType);

    try {
      const invoice = await this.db.invoice.create({
        data: {
          contentHash,
          storageKey,
          originalFilename: sanitizeFilename(filename),
          mimeType: type.mimeType,
          sizeBytes: data.length,
          ...(this.options.maxAttempts ? { maxAttempts: this.options.maxAttempts } : {}),
          events: { create: { type: 'uploaded', message: `received ${filename}` } },
        },
      });
      return { invoice, duplicate: false };
    } catch (err) {
      // Lost a race with a concurrent upload of the same bytes: return the winner's row.
      if (isUniqueViolation(err)) {
        const winner = await this.db.invoice.findUniqueOrThrow({ where: { contentHash } });
        return { invoice: winner, duplicate: true };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(params: { status?: InvoiceStatus[]; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const rows = await this.db.invoice.findMany({
      where: params.status?.length ? { status: { in: params.status } } : {},
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // oldest first: a queue
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => this.summarise(r)),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async counts(): Promise<Record<InvoiceStatus, number>> {
    const grouped = await this.db.invoice.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = Object.fromEntries(INVOICE_STATUSES.map((s) => [s, 0])) as Record<
      InvoiceStatus,
      number
    >;
    for (const g of grouped) counts[g.status] = g._count._all;
    return counts;
  }

  async get(id: string): Promise<InvoiceDetail> {
    const row = await this.db.invoice.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) throw notFound('invoice');
    const { extracted: rawExtracted, reviewed: rawReviewed, events, ...invoice } = row;
    const extracted = parseExtracted(rawExtracted);
    const draft = rawReviewed ? reviewDraftSchema.parse(rawReviewed) : null;
    const threshold = this.options.confidenceThreshold;
    return {
      invoice,
      extracted,
      form: mergeForReview(extracted, draft),
      lowConfidence: extracted ? lowConfidenceFields(extracted, threshold) : [],
      confidenceThreshold: threshold,
      events: events.map(({ id: eid, type, message, createdAt }) => ({
        id: eid,
        type,
        message,
        createdAt,
      })),
    };
  }

  async getFile(id: string): Promise<{ data: Buffer; mimeType: string; filename: string }> {
    const row = await this.db.invoice.findUnique({ where: { id } });
    if (!row) throw notFound('invoice');
    return {
      data: await this.storage.get(row.storageKey),
      mimeType: row.mimeType,
      filename: row.originalFilename,
    };
  }

  // ---------------------------------------------------------------------------
  // Review actions
  // ---------------------------------------------------------------------------

  /** Save the reviewer's edits without approving. */
  async saveDraft(id: string, input: unknown, reviewer?: string): Promise<InvoiceDetail> {
    const parsed = reviewDraftSchema.safeParse(input);
    if (!parsed.success) throw unprocessable('invalid review data', parsed.error.issues);
    await this.transition(id, REVIEWABLE, {
      data: { reviewed: parsed.data as Prisma.InputJsonValue, reviewedBy: reviewer ?? null },
      event: { type: 'review_saved', message: reviewer ? `saved by ${reviewer}` : 'draft saved' },
    });
    return this.get(id);
  }

  /**
   * Approve with the final reviewed values. Idempotent: approving an invoice
   * that is already approved (double-click, retry) returns it unchanged.
   */
  async approve(
    id: string,
    input: unknown,
    reviewer?: string,
  ): Promise<{ invoice: Invoice; alreadyApproved: boolean; reviewed: ReviewedInvoice }> {
    const current = await this.db.invoice.findUnique({ where: { id } });
    if (!current) throw notFound('invoice');
    if (ALREADY_APPROVED.includes(current.status)) {
      return {
        invoice: current,
        alreadyApproved: true,
        reviewed: reviewedInvoiceSchema.parse(current.reviewed),
      };
    }

    const parsed = reviewedInvoiceSchema.safeParse(input);
    if (!parsed.success) throw unprocessable('invoice is not ready to approve', parsed.error.issues);

    const invoice = await this.transition(id, REVIEWABLE, {
      data: {
        reviewed: parsed.data as Prisma.InputJsonValue,
        reviewedBy: reviewer ?? null,
        approvedAt: new Date(),
      },
      to: 'approved',
      event: { type: 'approved', message: reviewer ? `approved by ${reviewer}` : 'approved' },
    });
    return { invoice, alreadyApproved: false, reviewed: parsed.data };
  }

  async reject(id: string, reason: string, reviewer?: string): Promise<Invoice> {
    if (!reason.trim()) throw badRequest('a reason is required');
    return this.transition(id, REVIEWABLE, {
      to: 'rejected',
      data: { reviewedBy: reviewer ?? null },
      event: { type: 'rejected', message: reason.trim() },
    });
  }

  /** Put a failed invoice back in the extraction queue with a fresh attempt budget. */
  async retry(id: string): Promise<Invoice> {
    return this.transition(id, ['failed'], {
      to: 'pending',
      data: { attempts: 0, nextAttemptAt: new Date(), lockedAt: null, lockedBy: null },
      event: { type: 'retry_requested', message: 'manually re-queued' },
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Compare-and-set status change: the UPDATE only matches if the row is still
   * in an allowed state, so two concurrent requests can't both win.
   */
  private async transition(
    id: string,
    from: InvoiceStatus[],
    change: {
      to?: InvoiceStatus;
      data?: Prisma.InvoiceUpdateManyMutationInput;
      event: { type: string; message?: string };
    },
  ): Promise<Invoice> {
    return this.db.$transaction(async (tx) => {
      const res = await tx.invoice.updateMany({
        where: { id, status: { in: from } },
        data: { ...change.data, ...(change.to ? { status: change.to } : {}) },
      });
      if (res.count === 0) {
        const cur = await tx.invoice.findUnique({ where: { id }, select: { status: true } });
        if (!cur) throw notFound('invoice');
        throw conflict(`invoice is '${cur.status}', expected ${from.map((s) => `'${s}'`).join(' or ')}`, {
          status: cur.status,
        });
      }
      await tx.invoiceEvent.create({ data: { invoiceId: id, ...change.event } });
      return tx.invoice.findUniqueOrThrow({ where: { id } });
    });
  }

  private summarise(r: Invoice): InvoiceSummary {
    const extracted = parseExtracted(r.extracted);
    const draft = r.reviewed ? reviewDraftSchema.safeParse(r.reviewed).data ?? null : null;
    const form = mergeForReview(extracted, draft);
    return {
      id: r.id,
      status: r.status,
      originalFilename: r.originalFilename,
      vendorName: form.vendorName ?? null,
      invoiceNumber: form.invoiceNumber ?? null,
      total: form.total ?? null,
      currency: form.currency ?? null,
      lowConfidenceCount: extracted
        ? lowConfidenceFields(extracted, this.options.confidenceThreshold).length
        : 0,
      attempts: r.attempts,
      lastError: r.lastError,
      externalId: r.externalId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

function parseExtracted(value: Prisma.JsonValue | null): ExtractedInvoice | null {
  if (value === null) return null;
  const parsed = extractedInvoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'invoice';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'invoice';
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
