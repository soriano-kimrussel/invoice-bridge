import type { ReconcileResultDto } from '../domain/api.js';
import { reviewedInvoiceSchema, toCents, type ReviewedInvoice } from '../domain/invoice.js';
import { Prisma, type Db, type InvoiceStatus } from '../db.js';
import { AppError, conflict, notFound } from '../errors.js';
import { backoffMs, type BackoffOptions } from '../worker/backoff.js';
import type { WorkerLogger } from '../worker/extractionWorker.js';
import { AccountingError, type AccountingProvider, type ExternalBill } from './types.js';

/** Provider statuses that mean "the bill exists and is live". VOIDED / DELETED are mismatches. */
export const LIVE_BILL_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID']);

const RECONCILABLE: InvoiceStatus[] = ['submitted', 'posted', 'mismatch'];

export type PostResult = {
  status: InvoiceStatus;
  externalId: string;
  /** true when no new bill was created (already posted, or recovered an orphan). */
  reused: boolean;
  reconcile?: ReconcileResultDto;
  reconcileError?: string;
};

export type PostingOptions = {
  maxPostAttempts?: number;
  backoff?: BackoffOptions;
  random?: () => number;
  logger?: WorkerLogger;
  /** How long to hold the per-invoice lock while talking to the provider. */
  transactionTimeoutMs?: number;
};

const silent: WorkerLogger = { info() {}, warn() {}, error() {} };

/**
 * Posts approved invoices to the accounting system exactly once and reconciles them.
 *
 * Idempotency, in layers:
 *  1. Per-invoice row lock (SELECT … FOR UPDATE) around the whole post, so a
 *     double-click, a retry and the background sweeper serialise; whoever goes
 *     second sees the stored external id and reuses it.
 *  2. Stored external id: once `external_id` is set we never call createBill again.
 *  3. Orphan recovery: if a previous attempt created the bill but crashed before
 *     committing its id, `findOwnBill` (bills created by this app, same supplier +
 *     invoice number) finds it and we adopt it instead of creating a second one.
 *  4. Provider idempotency key = our invoice id (Xero's Idempotency-Key header).
 *  5. UNIQUE (accounting_provider, external_id): two of our invoices can never
 *     claim the same bill.
 */
export class PostingService {
  private readonly maxPostAttempts: number;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;
  private readonly log: WorkerLogger;
  private readonly txTimeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly provider: AccountingProvider,
    opts: PostingOptions = {},
  ) {
    this.maxPostAttempts = opts.maxPostAttempts ?? 5;
    this.backoff = opts.backoff ?? { baseMs: 30_000, maxMs: 30 * 60_000 };
    this.random = opts.random ?? Math.random;
    this.log = opts.logger ?? silent;
    this.txTimeoutMs = opts.transactionTimeoutMs ?? 120_000;
  }

  // ---------------------------------------------------------------------------
  // Posting
  // ---------------------------------------------------------------------------

  async post(invoiceId: string): Promise<PostResult> {
    let posted: { externalId: string; reused: boolean };
    try {
      posted = await this.db.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
          if (locked.length === 0) throw notFound('invoice');
          const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

          // (2) Already posted: reuse, never create again.
          if (inv.externalId) return { externalId: inv.externalId, reused: true };
          if (inv.status !== 'approved') {
            throw conflict(`invoice is '${inv.status}'; only approved invoices can be posted`, { status: inv.status });
          }
          const reviewed = reviewedInvoiceSchema.parse(inv.reviewed);

          // (3) Recover a bill created by an earlier attempt that crashed before commit.
          const orphan = await this.provider.findOwnBill({
            contactName: reviewed.vendorName,
            invoiceNumber: reviewed.invoiceNumber,
          });
          const bill = orphan ?? (await this.provider.createBill({ idempotencyKey: invoiceId, invoice: reviewed }));
          if (!bill.externalId) throw new AccountingError('provider returned a bill without an id', true);

          await tx.invoice.update({
            where: { id: invoiceId },
            data: {
              status: 'submitted',
              accountingProvider: this.provider.name,
              externalId: bill.externalId,
              postedAt: new Date(),
              postAttempts: { increment: 1 },
              nextPostAt: null,
              lastError: null,
            },
          });
          await tx.invoiceEvent.create({
            data: {
              invoiceId,
              type: orphan ? 'bill_recovered' : 'bill_created',
              message: orphan
                ? `found existing ${this.provider.name} bill ${bill.externalId} from an earlier attempt; reused it`
                : `created draft ${this.provider.name} bill ${bill.externalId}`,
              data: { externalId: bill.externalId, providerStatus: bill.status },
            },
          });
          return { externalId: bill.externalId, reused: Boolean(orphan) };
        },
        { timeout: this.txTimeoutMs, maxWait: this.txTimeoutMs },
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = isUniqueViolation(err)
        ? 'this bill is already linked to another invoice in invoice-bridge (likely a duplicate supplier invoice)'
        : (err as Error).message;
      const retryable = err instanceof AccountingError ? err.retryable : !isUniqueViolation(err);
      await this.recordPostFailure(invoiceId, message, retryable);
      throw new AppError(502, 'accounting_error', message);
    }

    this.log.info({ invoiceId, externalId: posted.externalId, reused: posted.reused }, 'invoice posted');

    // Reconcile straight away; if that fails transiently the invoice stays 'submitted'
    // and the sweeper (or the Re-run button) reconciles later.
    try {
      const reconcile = await this.reconcile(invoiceId);
      return { status: reconcile.ok ? 'posted' : 'mismatch', ...posted, reconcile };
    } catch (err) {
      return { status: 'submitted', ...posted, reconcileError: (err as Error).message };
    }
  }

  private async recordPostFailure(invoiceId: string, message: string, retryable: boolean) {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.status !== 'approved') return;
    const attempts = inv.postAttempts + 1;
    const willRetry = retryable && attempts < this.maxPostAttempts;
    const delay = backoffMs(attempts, this.backoff, this.random);
    await this.db.$transaction([
      this.db.invoice.updateMany({
        where: { id: invoiceId, status: 'approved', externalId: null },
        data: {
          postAttempts: attempts,
          lastError: message,
          nextPostAt: willRetry ? new Date(Date.now() + delay) : null,
        },
      }),
      this.db.invoiceEvent.create({
        data: {
          invoiceId,
          type: 'post_failed',
          message: willRetry
            ? `posting attempt ${attempts}/${this.maxPostAttempts} failed, retrying in ${Math.round(delay / 1000)}s: ${message}`
            : `posting failed (${retryable ? 'attempts exhausted' : 'not retryable'}); use "Post to Xero" to try again: ${message}`,
          data: { attempt: attempts, retryable, willRetry },
        },
      }),
    ]);
    this.log.warn({ invoiceId, attempt: attempts, willRetry, err: message }, 'posting failed');
  }

  /** Manual "Post to Xero" after automatic retries gave up: reset the budget, then post. */
  async retryPost(invoiceId: string): Promise<PostResult> {
    await this.db.invoice.updateMany({
      where: { id: invoiceId, status: 'approved', externalId: null },
      data: { postAttempts: 0, nextPostAt: null },
    });
    return this.post(invoiceId);
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Re-read the bill and compare it to what was approved. Read-only towards the
   * provider and idempotent here (it only rewrites the result), so it can be
   * re-run at any time. Transient provider errors leave the status unchanged.
   */
  async reconcile(invoiceId: string): Promise<ReconcileResultDto> {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw notFound('invoice');
    if (!inv.externalId || !RECONCILABLE.includes(inv.status)) {
      throw conflict(`invoice is '${inv.status}' and has not been posted`, { status: inv.status });
    }
    const reviewed = reviewedInvoiceSchema.parse(inv.reviewed);

    let bill: ExternalBill | null;
    try {
      bill = await this.provider.getBill(inv.externalId);
    } catch (err) {
      const message = `reconciliation could not read the bill: ${(err as Error).message}`;
      await this.db.$transaction([
        this.db.invoice.update({ where: { id: invoiceId }, data: { lastError: message } }),
        this.db.invoiceEvent.create({ data: { invoiceId, type: 'reconcile_error', message } }),
      ]);
      throw new AppError(502, 'accounting_error', message);
    }

    const result = compareBill(reviewed, bill);
    const next: InvoiceStatus = result.ok ? 'posted' : 'mismatch';

    await this.db.$transaction(async (tx) => {
      const res = await tx.invoice.updateMany({
        where: { id: invoiceId, status: { in: RECONCILABLE }, externalId: inv.externalId },
        data: {
          status: next,
          reconciledAt: new Date(result.checkedAt),
          reconcileResult: result as unknown as Prisma.InputJsonValue,
          lastError: null,
        },
      });
      if (res.count === 0) return;
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          type: result.ok ? 'reconciled' : 'reconcile_mismatch',
          message: result.ok
            ? `${this.provider.name} bill matches (total ${result.theirs.total?.toFixed(2)}, ${result.theirs.status})`
            : `mismatch: ${result.mismatches.join('; ')}`,
          data: result as unknown as Prisma.InputJsonValue,
        },
      });
    });
    if (!result.ok) this.log.warn({ invoiceId, mismatches: result.mismatches }, 'reconciliation mismatch');
    return result;
  }

  // ---------------------------------------------------------------------------
  // Background sweep
  // ---------------------------------------------------------------------------

  /**
   * One pass of the safety net:
   *  - retry posts that failed transiently and are due;
   *  - post approvals whose request died before posting (approved > 2 min ago, never attempted);
   *  - reconcile anything left in 'submitted' (post succeeded, reconcile didn't).
   */
  async sweep(limit = 20): Promise<{ posted: number; reconciled: number; errors: number }> {
    const now = new Date();
    const stale = new Date(now.getTime() - 2 * 60_000);
    const toPost = await this.db.invoice.findMany({
      where: {
        status: 'approved',
        externalId: null,
        postAttempts: { lt: this.maxPostAttempts },
        OR: [{ nextPostAt: { lte: now } }, { postAttempts: 0, nextPostAt: null, approvedAt: { lte: stale } }],
      },
      select: { id: true },
      orderBy: { approvedAt: 'asc' },
      take: limit,
    });
    const toReconcile = await this.db.invoice.findMany({
      where: { status: 'submitted', postedAt: { lte: new Date(now.getTime() - 30_000) } },
      select: { id: true },
      take: limit,
    });

    let posted = 0;
    let reconciled = 0;
    let errors = 0;
    for (const { id } of toPost) {
      try {
        await this.post(id);
        posted++;
      } catch {
        errors++; // already recorded on the invoice
      }
    }
    for (const { id } of toReconcile) {
      try {
        await this.reconcile(id);
        reconciled++;
      } catch {
        errors++;
      }
    }
    return { posted, reconciled, errors };
  }

  /** Re-check every posted invoice against the provider (e.g. nightly, or `npm run reconcile`). */
  async reconcileAll(statuses: InvoiceStatus[] = RECONCILABLE): Promise<{ ok: number; mismatch: number; errors: number }> {
    const rows = await this.db.invoice.findMany({
      where: { status: { in: statuses }, externalId: { not: null } },
      select: { id: true },
      orderBy: { postedAt: 'asc' },
    });
    const totals = { ok: 0, mismatch: 0, errors: 0 };
    for (const { id } of rows) {
      try {
        const r = await this.reconcile(id);
        totals[r.ok ? 'ok' : 'mismatch']++;
      } catch {
        totals.errors++;
      }
    }
    return totals;
  }
}

/** Pure comparison of what we approved vs what the provider holds. Money compared in integer cents. */
export function compareBill(ours: ReviewedInvoice, theirs: ExternalBill | null, now = new Date()): ReconcileResultDto {
  const oursView = { total: ours.total, status: 'DRAFT', currency: ours.currency, invoiceNumber: ours.invoiceNumber };
  if (!theirs) {
    return {
      ok: false,
      checkedAt: now.toISOString(),
      ours: oursView,
      theirs: { total: null, status: null, currency: null, invoiceNumber: null },
      mismatches: ['bill not found in the accounting system (deleted?)'],
    };
  }
  const mismatches: string[] = [];
  const cents = (n: number | null) => (n === null ? null : toCents(n));
  if (cents(theirs.total) !== toCents(ours.total)) {
    mismatches.push(`total: ours ${ours.total.toFixed(2)}, theirs ${theirs.total?.toFixed(2) ?? 'missing'}`);
  }
  if (theirs.subtotal !== null && cents(theirs.subtotal) !== toCents(ours.subtotal)) {
    mismatches.push(`subtotal: ours ${ours.subtotal.toFixed(2)}, theirs ${theirs.subtotal.toFixed(2)}`);
  }
  if (theirs.tax !== null && cents(theirs.tax) !== toCents(ours.tax)) {
    mismatches.push(`tax: ours ${ours.tax.toFixed(2)}, theirs ${theirs.tax.toFixed(2)}`);
  }
  if (!LIVE_BILL_STATUSES.has(theirs.status)) {
    mismatches.push(`status: bill is ${theirs.status || 'unknown'} in the accounting system`);
  }
  if (theirs.currency && theirs.currency !== ours.currency) {
    mismatches.push(`currency: ours ${ours.currency}, theirs ${theirs.currency}`);
  }
  if (theirs.invoiceNumber !== null && theirs.invoiceNumber !== ours.invoiceNumber) {
    mismatches.push(`invoice number: ours ${ours.invoiceNumber}, theirs ${theirs.invoiceNumber}`);
  }
  return {
    ok: mismatches.length === 0,
    checkedAt: now.toISOString(),
    ours: oursView,
    theirs: { total: theirs.total, status: theirs.status, currency: theirs.currency, invoiceNumber: theirs.invoiceNumber },
    mismatches,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
