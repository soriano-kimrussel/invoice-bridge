import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db, InvoiceStatus } from '../src/db.js';
import { MemoryFileStorage } from '../src/storage/index.js';
import { createTestDb, hasTestDb, resetDb } from './helpers/db.js';
import { extractedFixture, fakePdf, multipartBody, PNG_HEADER, reviewedFixture } from './helpers/fixtures.js';

describe.skipIf(!hasTestDb)('invoice API (PostgreSQL)', () => {
  let db: Db;
  let storage: MemoryFileStorage;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createTestDb();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(db);
    storage = new MemoryFileStorage();
    app = await buildApp({ db, storage, confidenceThreshold: 0.8, maxUploadBytes: 1024 * 1024 });
  });

  const upload = (file: Buffer, filename = 'invoice.pdf') =>
    app.inject({ method: 'POST', url: '/api/invoices', ...multipartBody(file, filename) });

  /** Seed an invoice as if the extraction worker had already processed it. */
  async function seedNeedsReview(seed = 'r1') {
    const res = await upload(fakePdf(seed));
    const { id } = res.json<{ id: string }>();
    await db.invoice.update({
      where: { id },
      data: { status: 'needs_review', extracted: extractedFixture(), extractedAt: new Date() },
    });
    return id;
  }

  // -------------------------------------------------------------------------
  describe('upload', () => {
    it('stores the file and creates a pending invoice with a content hash', async () => {
      const res = await upload(fakePdf('a'), 'acme-nov.pdf');
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ status: 'pending', duplicate: false });

      const row = await db.invoice.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.storageKey).toBe(`${row.contentHash}.pdf`);
      expect(row.mimeType).toBe('application/pdf');
      expect(row.originalFilename).toBe('acme-nov.pdf');
      expect(storage.files.has(row.storageKey)).toBe(true);
      expect(await db.invoiceEvent.count({ where: { invoiceId: row.id, type: 'uploaded' } })).toBe(1);
    });

    it('is idempotent: re-uploading identical bytes returns the same invoice', async () => {
      const first = (await upload(fakePdf('same'), 'a.pdf')).json();
      const second = await upload(fakePdf('same'), 'renamed-copy.pdf');
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ id: first.id, duplicate: true });
      expect(await db.invoice.count()).toBe(1);
    });

    it('creates exactly one row under concurrent uploads of the same file', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => upload(fakePdf('race'))));
      const ids = new Set(results.map((r) => r.json().id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(await db.invoice.count()).toBe(1);
    });

    it('accepts images', async () => {
      const res = await upload(PNG_HEADER, 'scan.png');
      expect(res.statusCode).toBe(201);
    });

    it('rejects files that are not PDFs/images by content, whatever their name', async () => {
      const res = await upload(Buffer.from('MZ this is an exe'), 'invoice.pdf');
      expect(res.statusCode).toBe(415);
      expect(await db.invoice.count()).toBe(0);
    });

    it('rejects files over the size limit with 413', async () => {
      const big = Buffer.concat([fakePdf(), Buffer.alloc(1024 * 1024 + 10)]);
      const res = await upload(big);
      expect(res.statusCode).toBe(413);
      expect(await db.invoice.count()).toBe(0);
    });

    it('rejects empty files and non-multipart requests', async () => {
      expect((await upload(Buffer.alloc(0))).statusCode).toBe(400);
      const res = await app.inject({ method: 'POST', url: '/api/invoices', payload: { a: 1 } });
      expect(res.statusCode).toBe(400);
    });

    it('sanitises the stored filename', async () => {
      const { id } = (await upload(fakePdf('fn'), '..\\..\\evil<script>.pdf')).json();
      const row = await db.invoice.findUniqueOrThrow({ where: { id } });
      expect(row.originalFilename).toBe('evil_script_.pdf');
    });
  });

  // -------------------------------------------------------------------------
  describe('review queue', () => {
    it('lists by status, oldest first, with summary fields and low-confidence count', async () => {
      const a = await seedNeedsReview('q1');
      const b = await seedNeedsReview('q2');
      await upload(fakePdf('still-pending'));

      const res = await app.inject({ url: '/api/invoices?status=needs_review' });
      expect(res.statusCode).toBe(200);
      const { items, nextCursor } = res.json();
      expect(items.map((i: { id: string }) => i.id)).toEqual([a, b]);
      expect(items[0]).toMatchObject({
        status: 'needs_review',
        vendorName: 'Acme Supplies Pty Ltd',
        invoiceNumber: 'INV-1001',
        total: 110,
        currency: 'AUD',
        lowConfidenceCount: 2,
      });
      expect(nextCursor).toBeNull();
    });

    it('paginates with a cursor', async () => {
      for (const s of ['p1', 'p2', 'p3']) await upload(fakePdf(s));
      const page1 = (await app.inject({ url: '/api/invoices?limit=2' })).json();
      expect(page1.items).toHaveLength(2);
      const page2 = (await app.inject({ url: `/api/invoices?limit=2&cursor=${page1.nextCursor}` })).json();
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
    });

    it('validates query parameters', async () => {
      expect((await app.inject({ url: '/api/invoices?status=bogus' })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/invoices/not-a-uuid' })).statusCode).toBe(400);
      expect(
        (await app.inject({ url: '/api/invoices/00000000-0000-4000-8000-000000000000' })).statusCode,
      ).toBe(404);
    });

    it('returns counts per status', async () => {
      await seedNeedsReview('c1');
      await upload(fakePdf('c2'));
      const counts = (await app.inject({ url: '/api/invoices/counts' })).json();
      expect(counts).toMatchObject({ needs_review: 1, pending: 1, posted: 0, failed: 0 });
    });

    it('returns detail with form values, low-confidence fields and events', async () => {
      const id = await seedNeedsReview();
      const body = (await app.inject({ url: `/api/invoices/${id}` })).json();
      expect(body.invoice.id).toBe(id);
      expect(body.form).toMatchObject({ vendorName: 'Acme Supplies Pty Ltd', total: 110 });
      expect(body.lowConfidence.sort()).toEqual(['dueDate', 'lineItems.0.unitPrice']);
      expect(body.confidenceThreshold).toBe(0.8);
      expect(body.events.map((e: { type: string }) => e.type)).toEqual(['uploaded']);
    });

    it('serves the original file with its content type', async () => {
      const id = await seedNeedsReview('file');
      const res = await app.inject({ url: `/api/invoices/${id}/file` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.equals(fakePdf('file'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('review actions', () => {
    const headers = { 'x-reviewer': 'Sam Reviewer' };

    it('saves a partial draft that then shows in the form', async () => {
      const id = await seedNeedsReview();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/invoices/${id}/review`,
        headers,
        payload: { vendorName: 'Acme Corrected', dueDate: '2026-12-15' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().form).toMatchObject({ vendorName: 'Acme Corrected', dueDate: '2026-12-15', total: 110 });
      const row = await db.invoice.findUniqueOrThrow({ where: { id } });
      expect(row.reviewedBy).toBe('Sam Reviewer');
      expect(row.status).toBe('needs_review');
    });

    it('rejects malformed draft values with 422', async () => {
      const id = await seedNeedsReview();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/invoices/${id}/review`,
        payload: { issueDate: '01/11/2026' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('approves a valid invoice and records who approved it', async () => {
      const id = await seedNeedsReview();
      const res = await app.inject({
        method: 'POST',
        url: `/api/invoices/${id}/approve`,
        headers,
        payload: reviewedFixture(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, status: 'approved', alreadyApproved: false });
      const row = await db.invoice.findUniqueOrThrow({ where: { id } });
      expect(row.approvedAt).toBeInstanceOf(Date);
      expect(row.reviewed).toMatchObject({ total: 110 });
      const ev = await db.invoiceEvent.findFirstOrThrow({ where: { invoiceId: id, type: 'approved' } });
      expect(ev.message).toBe('approved by Sam Reviewer');
    });

    it('refuses to approve inconsistent totals, with field-level details', async () => {
      const id = await seedNeedsReview();
      const res = await app.inject({
        method: 'POST',
        url: `/api/invoices/${id}/approve`,
        payload: reviewedFixture({ total: 120 }),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().details.map((d: { path: string[] }) => d.path.join('.'))).toContain('total');
      expect((await db.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('needs_review');
    });

    it('is idempotent: a double-click approve succeeds once and reports the second as already approved', async () => {
      const id = await seedNeedsReview();
      const approve = () =>
        app.inject({ method: 'POST', url: `/api/invoices/${id}/approve`, payload: reviewedFixture() });
      const first = await approve();
      const second = await approve();
      expect(first.json().alreadyApproved).toBe(false);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ status: 'approved', alreadyApproved: true });
      expect(await db.invoiceEvent.count({ where: { invoiceId: id, type: 'approved' } })).toBe(1);
    });

    it('lets exactly one of several concurrent approvals win', async () => {
      const id = await seedNeedsReview();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          app.inject({ method: 'POST', url: `/api/invoices/${id}/approve`, payload: reviewedFixture() }),
        ),
      );
      // Losers either saw it already approved (200) or lost the compare-and-set (409). Never two approvals.
      for (const r of results) expect([200, 409]).toContain(r.statusCode);
      expect(await db.invoiceEvent.count({ where: { invoiceId: id, type: 'approved' } })).toBe(1);
    });

    it.each<[InvoiceStatus]>([['pending'], ['processing'], ['failed'], ['rejected']])(
      'refuses to approve an invoice that is %s (409)',
      async (status) => {
        const id = await seedNeedsReview(`s-${status}`);
        await db.invoice.update({ where: { id }, data: { status } });
        const res = await app.inject({
          method: 'POST',
          url: `/api/invoices/${id}/approve`,
          payload: reviewedFixture(),
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().details.status).toBe(status);
      },
    );

    it('rejects with a reason', async () => {
      const id = await seedNeedsReview();
      expect(
        (await app.inject({ method: 'POST', url: `/api/invoices/${id}/reject`, payload: { reason: '' } }))
          .statusCode,
      ).toBe(400);
      const res = await app.inject({
        method: 'POST',
        url: `/api/invoices/${id}/reject`,
        payload: { reason: 'Duplicate of INV-0999' },
      });
      expect(res.json()).toEqual({ id, status: 'rejected' });
    });

    it('re-queues a failed invoice with a fresh attempt budget', async () => {
      const { id } = (await upload(fakePdf('fail'))).json();
      await db.invoice.update({ where: { id }, data: { status: 'failed', attempts: 5, lastError: 'boom' } });
      const res = await app.inject({ method: 'POST', url: `/api/invoices/${id}/retry` });
      expect(res.json()).toEqual({ id, status: 'pending' });
      const row = await db.invoice.findUniqueOrThrow({ where: { id } });
      expect(row.attempts).toBe(0);

      // only failed invoices can be retried
      expect((await app.inject({ method: 'POST', url: `/api/invoices/${id}/retry` })).statusCode).toBe(409);
    });
  });

  it('reports health', async () => {
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({ ok: true });
  });
});
