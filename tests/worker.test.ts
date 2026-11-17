import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import type { ExtractedInvoice } from '../src/domain/invoice.js';
import { ExtractionError, type InvoiceExtractor } from '../src/extraction/types.js';
import { MemoryFileStorage } from '../src/storage/index.js';
import { ExtractionWorker, type ExtractionWorkerOptions } from '../src/worker/extractionWorker.js';
import { createTestDb, hasTestDb, resetDb } from './helpers/db.js';
import { extractedFixture, fakePdf } from './helpers/fixtures.js';
import { TEST_DATABASE_URL } from './helpers/testEnv.js';

/** Scriptable stand-in for Azure Document Intelligence. */
class FakeExtractor implements InvoiceExtractor {
  readonly name = 'fake';
  calls: string[] = [];
  delayMs = 0;
  behaviour: (call: number) => ExtractedInvoice | Error = () => extractedFixture();

  async extract(file: Buffer): Promise<ExtractedInvoice> {
    this.calls.push(file.toString('latin1'));
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const out = this.behaviour(this.calls.length);
    if (out instanceof Error) throw out;
    return out;
  }
}

describe.skipIf(!hasTestDb)('ExtractionWorker (PostgreSQL)', () => {
  let db: Db;
  let storage: MemoryFileStorage;
  let extractor: FakeExtractor;

  const makeWorker = (id: string, opts: ExtractionWorkerOptions = {}) =>
    new ExtractionWorker(db, storage, extractor, {
      workerId: id,
      batchSize: 4,
      backoff: { baseMs: 1000, maxMs: 60_000 },
      random: () => 1,
      ...opts,
    });

  async function seedPending(n: number, data: { maxAttempts?: number } = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const bytes = fakePdf(`job-${i}-${Math.random()}`);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const key = `${hash}.pdf`;
      await storage.put(key, bytes, 'application/pdf');
      const row = await db.invoice.create({
        data: {
          contentHash: hash,
          storageKey: key,
          originalFilename: `inv-${i}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: bytes.length,
          // distinct, already-due times so ORDER BY is deterministic
          nextAttemptAt: new Date(Date.now() - 60_000 + i),
          ...data,
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  const row = (id: string) => db.invoice.findUniqueOrThrow({ where: { id } });
  const events = (id: string) =>
    db.invoiceEvent.findMany({ where: { invoiceId: id }, orderBy: { createdAt: 'asc' } });

  beforeAll(() => {
    db = createTestDb();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(db);
    storage = new MemoryFileStorage();
    extractor = new FakeExtractor();
  });

  // -------------------------------------------------------------------------
  describe('locking (FOR UPDATE SKIP LOCKED)', () => {
    it('hands every invoice to exactly one of many concurrent workers', async () => {
      const ids = await seedPending(24);
      extractor.delayMs = 15; // keep claims overlapping
      const workers = Array.from({ length: 6 }, (_, i) => makeWorker(`w${i}`, { batchSize: 3 }));

      const claimedBy = new Map<string, string[]>();
      await Promise.all(
        workers.map(async (w) => {
          for (;;) {
            const jobs = await w.claim();
            if (jobs.length === 0) return;
            for (const j of jobs) claimedBy.set(j.id, [...(claimedBy.get(j.id) ?? []), w.workerId]);
            await Promise.all(jobs.map((j) => w.process(j)));
          }
        }),
      );

      expect(claimedBy.size).toBe(24);
      for (const owners of claimedBy.values()) expect(owners).toHaveLength(1);
      expect(extractor.calls).toHaveLength(24);
      expect(new Set(extractor.calls).size).toBe(24);
      // Work was actually spread across workers, not serialised behind one lock.
      expect(new Set([...claimedBy.values()].flat()).size).toBeGreaterThan(1);

      const statuses = await db.invoice.groupBy({ by: ['status'], _count: { _all: true } });
      expect(statuses).toEqual([{ status: 'needs_review', _count: { _all: 24 } }]);
      for (const id of ids.slice(0, 3)) expect((await row(id)).attempts).toBe(1);
    });

    it('skips rows locked by another transaction instead of waiting for them', async () => {
      const [locked, a, b] = await seedPending(3);
      const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [locked]);

        const started = Date.now();
        const jobs = await makeWorker('w1', { batchSize: 10 }).claim();
        expect(Date.now() - started).toBeLessThan(2000); // did not block on the held lock
        expect(jobs.map((j) => j.id).sort()).toEqual([a, b].sort());
        expect((await row(locked!)).status).toBe('pending');
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    });

    it('does not claim invoices whose retry time is in the future, or that are not pending', async () => {
      const [future, review] = await seedPending(2);
      await db.invoice.update({ where: { id: future }, data: { nextAttemptAt: new Date(Date.now() + 60_000) } });
      await db.invoice.update({ where: { id: review }, data: { status: 'needs_review' } });
      expect(await makeWorker('w1').claim()).toEqual([]);
    });

    it('marks a claim as processing with owner and attempt count', async () => {
      const [id] = await seedPending(1);
      const [job] = await makeWorker('w-owner').claim();
      expect(job).toMatchObject({ id, attempts: 1, maxAttempts: 5, mimeType: 'application/pdf' });
      const r = await row(id!);
      expect(r).toMatchObject({ status: 'processing', lockedBy: 'w-owner', attempts: 1 });
      expect(r.lockedAt).toBeInstanceOf(Date);
    });
  });

  // -------------------------------------------------------------------------
  describe('processing', () => {
    it('stores validated extraction with confidences and moves to needs_review', async () => {
      const [id] = await seedPending(1);
      const summary = await makeWorker('w1').runOnce();
      expect(summary).toMatchObject({ claimed: 1, succeeded: 1 });

      const r = await row(id!);
      expect(r).toMatchObject({ status: 'needs_review', lockedBy: null, lockedAt: null, lastError: null });
      expect(r.extracted).toMatchObject({ total: { value: 110, confidence: 0.99 }, dueDate: { confidence: 0.6 } });
      expect(r.extractedAt).toBeInstanceOf(Date);

      const ev = (await events(id!)).at(-1)!;
      expect(ev.type).toBe('extracted');
      expect(ev.data).toMatchObject({ attempt: 1, lowConfidence: ['dueDate', 'lineItems.0.unitPrice'] });
    });

    it('retries a transient failure with backoff, then succeeds', async () => {
      const [id] = await seedPending(1);
      extractor.behaviour = (n) => (n === 1 ? new ExtractionError('429 throttled', true) : extractedFixture());
      const w = makeWorker('w1');

      const before = Date.now();
      expect(await w.runOnce()).toMatchObject({ retry_scheduled: 1 });
      let r = await row(id!);
      expect(r).toMatchObject({ status: 'pending', attempts: 1, lastError: '429 throttled', lockedBy: null });
      // random() = 1 ⇒ full delay of base · 2^0 = 1000 ms
      expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 1000);

      // Not due yet: nothing to claim.
      expect((await w.runOnce()).claimed).toBe(0);

      await db.invoice.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
      expect(await w.runOnce()).toMatchObject({ succeeded: 1 });
      r = await row(id!);
      expect(r).toMatchObject({ status: 'needs_review', attempts: 2, lastError: null });
      expect((await events(id!)).map((e) => e.type)).toEqual(['extraction_retry', 'extracted']);
    });

    it('gives up after max attempts and marks the invoice failed with the error', async () => {
      const [id] = await seedPending(1, { maxAttempts: 3 });
      extractor.behaviour = () => new ExtractionError('Azure 503', true);
      const w = makeWorker('w1');

      for (let i = 0; i < 3; i++) {
        await db.invoice.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
        await w.runOnce();
      }
      const r = await row(id!);
      expect(r).toMatchObject({ status: 'failed', attempts: 3, lastError: 'Azure 503' });
      expect(extractor.calls).toHaveLength(3);
      expect((await events(id!)).map((e) => e.type)).toEqual([
        'extraction_retry',
        'extraction_retry',
        'extraction_failed',
      ]);

      // A failed invoice is never claimed again automatically.
      await db.invoice.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
      expect((await w.runOnce()).claimed).toBe(0);
    });

    it('fails immediately on a non-retryable error', async () => {
      const [id] = await seedPending(1);
      extractor.behaviour = () => new ExtractionError('InvalidContent: corrupt PDF', false);
      expect(await makeWorker('w1').runOnce()).toMatchObject({ failed: 1 });
      expect(await row(id!)).toMatchObject({ status: 'failed', attempts: 1 });
      const ev = (await events(id!)).at(-1)!;
      expect(ev.message).toMatch(/non-retryable/);
    });

    it('fails (not retries) when the stored file is missing', async () => {
      const [id] = await seedPending(1);
      storage.files.clear();
      expect(await makeWorker('w1').runOnce()).toMatchObject({ failed: 1 });
      expect((await row(id!)).lastError).toMatch(/file not found/);
      expect(extractor.calls).toHaveLength(0);
    });

    it('treats unexpected errors as retryable', async () => {
      const [id] = await seedPending(1);
      extractor.behaviour = () => new Error('socket hang up');
      await makeWorker('w1').runOnce();
      expect(await row(id!)).toMatchObject({ status: 'pending', lastError: 'socket hang up' });
    });
  });

  // -------------------------------------------------------------------------
  describe('crash recovery', () => {
    const expireLease = (id: string) =>
      db.invoice.update({ where: { id }, data: { lockedAt: new Date(Date.now() - 10 * 60_000) } });

    it('reclaims an invoice whose worker died mid-extraction', async () => {
      const [id] = await seedPending(1);
      const crashed = makeWorker('crashed', { leaseSeconds: 60 });
      await crashed.claim(); // claimed, then the process "dies"

      const rescuer = makeWorker('rescuer', { leaseSeconds: 60 });
      expect((await rescuer.claim()).length).toBe(0); // lease still valid

      await expireLease(id!);
      expect(await rescuer.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(await row(id!)).toMatchObject({ status: 'needs_review', attempts: 2 });
    });

    it('fences out a worker that lost its lease: its late result is discarded', async () => {
      const [id] = await seedPending(1);
      const slow = makeWorker('slow', { leaseSeconds: 60 });
      const [slowJob] = await slow.claim();

      await expireLease(id!);
      const fast = makeWorker('fast', { leaseSeconds: 60 });
      extractor.behaviour = () => extractedFixture({ invoiceNumber: { value: 'FROM-FAST', confidence: 1 } });
      expect(await fast.runOnce()).toMatchObject({ succeeded: 1 });

      // The slow worker finally finishes; its write-back must not clobber the new owner's result.
      extractor.behaviour = () => extractedFixture({ invoiceNumber: { value: 'FROM-SLOW', confidence: 1 } });
      expect(await slow.process(slowJob!)).toBe('lost_lease');
      expect((await row(id!)).extracted).toMatchObject({ invoiceNumber: { value: 'FROM-FAST' } });
      expect((await events(id!)).filter((e) => e.type === 'extracted')).toHaveLength(1);
    });

    it('marks an expired claim with no attempts left as failed instead of leaving it stuck', async () => {
      const [id] = await seedPending(1, { maxAttempts: 1 });
      await makeWorker('crashed', { leaseSeconds: 60 }).claim();
      await expireLease(id!);

      const summary = await makeWorker('rescuer', { leaseSeconds: 60 }).runOnce();
      expect(summary).toMatchObject({ reaped: 1, claimed: 0 });
      const r = await row(id!);
      expect(r).toMatchObject({ status: 'failed', lockedBy: null });
      expect(r.lastError).toMatch(/lease expired/);
      expect((await events(id!)).at(-1)?.type).toBe('extraction_failed');
    });
  });

  // -------------------------------------------------------------------------
  it('start()/stop() drains the queue and stops cleanly', async () => {
    await seedPending(5);
    const w = makeWorker('loop', { pollIntervalMs: 20, batchSize: 2 });
    w.start();
    const deadline = Date.now() + 10_000;
    while ((await db.invoice.count({ where: { status: 'needs_review' } })) < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await w.stop();
    expect(await db.invoice.count({ where: { status: 'needs_review' } })).toBe(5);
  });
});
