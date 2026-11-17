import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { Prisma} from '../db.js';
import { type Db } from '../db.js';
import { lowConfidenceFields } from '../domain/invoice.js';
import { ExtractionError, type InvoiceExtractor } from '../extraction/types.js';
import { FileNotFoundError, type FileStorage } from '../storage/types.js';
import { backoffMs, type BackoffOptions } from './backoff.js';

/** A row this worker has claimed. `attempts` is the fencing token for this claim. */
export type ClaimedJob = {
  id: string;
  storageKey: string;
  mimeType: string;
  attempts: number;
  maxAttempts: number;
};

export type JobOutcome = 'succeeded' | 'retry_scheduled' | 'failed' | 'lost_lease';

export type RunSummary = { claimed: number; reaped: number } & Record<JobOutcome, number>;

export type WorkerLogger = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type ExtractionWorkerOptions = {
  workerId?: string;
  /** How many invoices to claim and process concurrently per tick. */
  batchSize?: number;
  /** A claim older than this is presumed dead (crashed worker) and can be reclaimed. */
  leaseSeconds?: number;
  pollIntervalMs?: number;
  backoff?: BackoffOptions;
  confidenceThreshold?: number;
  random?: () => number;
  logger?: WorkerLogger;
};

const silent: WorkerLogger = { info() {}, warn() {}, error() {} };

/**
 * Postgres-backed extraction queue worker.
 *
 * Claiming uses `SELECT … FOR UPDATE SKIP LOCKED` inside a single UPDATE, so
 * any number of workers (threads, processes, App Service instances) can poll
 * the same table and every due invoice is handed to exactly one of them.
 * The claim is committed immediately (status = processing, locked_by, attempts+1)
 * so the slow Azure call happens outside any transaction. A crashed worker's
 * claim expires after `leaseSeconds` and is picked up again; every write-back
 * is fenced on (locked_by, attempts) so a worker that lost its lease can't
 * overwrite the new owner's result.
 */
export class ExtractionWorker {
  readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly backoff: BackoffOptions;
  private readonly confidenceThreshold: number;
  private readonly random: () => number;
  private readonly log: WorkerLogger;

  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
    private readonly extractor: InvoiceExtractor,
    opts: ExtractionWorkerOptions = {},
  ) {
    this.workerId = opts.workerId ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.batchSize = opts.batchSize ?? 4;
    this.leaseSeconds = opts.leaseSeconds ?? 300;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.backoff = opts.backoff ?? { baseMs: 5000, maxMs: 10 * 60 * 1000 };
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.8;
    this.random = opts.random ?? Math.random;
    this.log = opts.logger ?? silent;
  }

  // ---------------------------------------------------------------------------
  // Queue primitives
  // ---------------------------------------------------------------------------

  /** Atomically claim up to `limit` due invoices. Never blocks on rows other workers hold. */
  async claim(limit = this.batchSize): Promise<ClaimedJob[]> {
    return this.db.$queryRaw<ClaimedJob[]>`
      UPDATE invoices AS i
         SET status     = 'processing',
             locked_at  = now(),
             locked_by  = ${this.workerId},
             attempts   = i.attempts + 1,
             updated_at = now()
        FROM (
              SELECT id
                FROM invoices
               WHERE attempts < max_attempts
                 AND (   (status = 'pending' AND next_attempt_at <= now())
                      OR (status = 'processing'
                          AND locked_at < now() - make_interval(secs => ${this.leaseSeconds}::double precision)))
               ORDER BY next_attempt_at, created_at
               LIMIT ${limit}::int
               FOR UPDATE SKIP LOCKED
             ) AS due
       WHERE i.id = due.id
   RETURNING i.id,
             i.storage_key  AS "storageKey",
             i.mime_type    AS "mimeType",
             i.attempts,
             i.max_attempts AS "maxAttempts"`;
  }

  /**
   * Claims whose lease expired with no attempts left can't be reclaimed, so
   * mark them failed instead of leaving them stuck in `processing` forever.
   */
  async reapExhausted(): Promise<number> {
    return this.db.$executeRaw`
      WITH reaped AS (
        UPDATE invoices
           SET status     = 'failed',
               last_error = 'worker lease expired (worker crashed or timed out) with no attempts left',
               locked_at  = NULL,
               locked_by  = NULL,
               updated_at = now()
         WHERE id IN (
               SELECT id FROM invoices
                WHERE status = 'processing'
                  AND attempts >= max_attempts
                  AND locked_at < now() - make_interval(secs => ${this.leaseSeconds}::double precision)
                FOR UPDATE SKIP LOCKED)
     RETURNING id, last_error, attempts
      )
      INSERT INTO invoice_events (id, invoice_id, type, message, data)
      SELECT gen_random_uuid(), id, 'extraction_failed', last_error, jsonb_build_object('attempts', attempts)
        FROM reaped`;
  }

  // ---------------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------------

  /** One tick: reap, claim a batch, process it concurrently. */
  async runOnce(): Promise<RunSummary> {
    const reaped = await this.reapExhausted();
    const jobs = await this.claim();
    const summary: RunSummary = {
      claimed: jobs.length,
      reaped,
      succeeded: 0,
      retry_scheduled: 0,
      failed: 0,
      lost_lease: 0,
    };
    const outcomes = await Promise.all(jobs.map((job) => this.process(job)));
    for (const o of outcomes) summary[o]++;
    return summary;
  }

  async process(job: ClaimedJob): Promise<JobOutcome> {
    const started = Date.now();
    try {
      const file = await this.storage.get(job.storageKey);
      const extracted = await this.extractor.extract(file, job.mimeType);
      const low = lowConfidenceFields(extracted, this.confidenceThreshold);

      const ok = await this.writeBack(job, {
        data: {
          status: 'needs_review',
          extracted: extracted as Prisma.InputJsonValue,
          extractedAt: new Date(),
          lastError: null,
        },
        event: {
          type: 'extracted',
          message: low.length
            ? `extracted; ${low.length} field(s) below ${this.confidenceThreshold} confidence`
            : 'extracted',
          data: { attempt: job.attempts, model: extracted.modelId, lowConfidence: low, ms: Date.now() - started },
        },
      });
      if (!ok) return 'lost_lease';
      this.log.info({ invoiceId: job.id, attempt: job.attempts, lowConfidence: low.length }, 'invoice extracted');
      return 'succeeded';
    } catch (err) {
      return this.handleFailure(job, err);
    }
  }

  private async handleFailure(job: ClaimedJob, err: unknown): Promise<JobOutcome> {
    const message = errorMessage(err);
    const retryable = isRetryable(err);
    const exhausted = job.attempts >= job.maxAttempts;

    if (retryable && !exhausted) {
      const delay = backoffMs(job.attempts, this.backoff, this.random);
      const nextAttemptAt = new Date(Date.now() + delay);
      const ok = await this.writeBack(job, {
        data: { status: 'pending', nextAttemptAt, lastError: message },
        event: {
          type: 'extraction_retry',
          message: `attempt ${job.attempts}/${job.maxAttempts} failed, retrying in ${Math.round(delay / 1000)}s: ${message}`,
          data: { attempt: job.attempts, retryInMs: delay, error: message },
        },
      });
      this.log.warn({ invoiceId: job.id, attempt: job.attempts, delay, err: message }, 'extraction failed, will retry');
      return ok ? 'retry_scheduled' : 'lost_lease';
    }

    const reason = retryable ? `gave up after ${job.attempts} attempts` : 'non-retryable error';
    const ok = await this.writeBack(job, {
      data: { status: 'failed', lastError: message },
      event: {
        type: 'extraction_failed',
        message: `${reason}: ${message}`,
        data: {
          attempt: job.attempts,
          retryable,
          error: message,
          details: (err instanceof ExtractionError ? err.details : undefined) as Prisma.InputJsonValue | undefined,
        },
      },
    });
    this.log.error({ invoiceId: job.id, attempt: job.attempts, err: message }, `extraction failed: ${reason}`);
    return ok ? 'failed' : 'lost_lease';
  }

  /**
   * Fenced write-back: only applies if this worker still owns the claim.
   * Returns false if the lease expired and someone else reclaimed the row.
   */
  private async writeBack(
    job: ClaimedJob,
    change: {
      data: Prisma.InvoiceUpdateManyMutationInput;
      event: { type: string; message: string; data?: Prisma.InputJsonValue };
    },
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const res = await tx.invoice.updateMany({
        where: { id: job.id, status: 'processing', lockedBy: this.workerId, attempts: job.attempts },
        data: { ...change.data, lockedAt: null, lockedBy: null },
      });
      if (res.count === 0) {
        this.log.warn({ invoiceId: job.id, attempt: job.attempts }, 'lost lease before write-back; discarding result');
        return false;
      }
      await tx.invoiceEvent.create({ data: { invoiceId: job.id, ...change.event } });
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info({ workerId: this.workerId, batchSize: this.batchSize }, 'extraction worker started');
    this.loop = (async () => {
      while (this.running) {
        let claimed = 0;
        try {
          claimed = (await this.runOnce()).claimed;
        } catch (err) {
          // e.g. database briefly unavailable: log and keep polling, never crash the loop.
          this.log.error({ err: errorMessage(err) }, 'worker tick failed');
        }
        // A full batch means there is probably more work: go again immediately.
        if (this.running && claimed < this.batchSize) await this.sleep(this.pollIntervalMs);
      }
    })();
  }

  /** Stop polling and wait for in-flight invoices to finish. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.log.info({ workerId: this.workerId }, 'extraction worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ExtractionError) return err.retryable;
  if (err instanceof FileNotFoundError) return false; // the original is gone; retrying can't help
  return true; // unknown errors (network, DB blips) get the benefit of the doubt, bounded by maxAttempts
}

function errorMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 2000 ? `${m.slice(0, 2000)}…` : m;
}
