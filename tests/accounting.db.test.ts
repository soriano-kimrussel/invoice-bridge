import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenCipher } from '../src/accounting/crypto.js';
import type { AccountingModule } from '../src/accounting/index.js';
import { PostingService } from '../src/accounting/postingService.js';
import { TokenStore } from '../src/accounting/tokenStore.js';
import { AccountingError, NotConnectedError } from '../src/accounting/types.js';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { MemoryFileStorage } from '../src/storage/index.js';
import { createTestDb, hasTestDb, resetDb } from './helpers/db.js';
import { FakeAccountingProvider, FakeOAuthClient, TEST_TOKEN_KEY } from './helpers/fakeAccounting.js';
import { extractedFixture, fakePdf, reviewedFixture } from './helpers/fixtures.js';

describe.skipIf(!hasTestDb)('accounting (PostgreSQL, Xero mocked)', () => {
  let db: Db;
  const cipher = new TokenCipher(TEST_TOKEN_KEY);

  beforeAll(() => {
    db = createTestDb();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  /** An invoice already approved by a reviewer. */
  async function seedApproved(seed = 'a', reviewed = reviewedFixture()) {
    const bytes = fakePdf(seed);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const row = await db.invoice.create({
      data: {
        contentHash: hash,
        storageKey: `${hash}.pdf`,
        originalFilename: `${seed}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        status: 'approved',
        extracted: extractedFixture(),
        reviewed,
        approvedAt: new Date(),
      },
    });
    return row.id;
  }
  const row = (id: string) => db.invoice.findUniqueOrThrow({ where: { id } });
  const eventTypes = async (id: string) =>
    (await db.invoiceEvent.findMany({ where: { invoiceId: id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);

  // ===========================================================================
  describe('TokenStore: tokens in the database, refreshed before expiry', () => {
    let oauth: FakeOAuthClient;
    let clock: Date;
    const store = (o: Partial<{ skewMs: number }> = {}) =>
      new TokenStore(db, oauth, cipher, { provider: 'xero', refreshSkewMs: o.skewMs ?? 5 * 60_000, now: () => clock });

    beforeEach(async () => {
      oauth = new FakeOAuthClient(30 * 60_000);
      clock = new Date();
      const { tokens, tenants } = await oauth.exchangeCode('cb', 'state');
      await store().saveConnection(tokens, tenants[0]!);
    });

    it('stores tokens encrypted, never in plain text', async () => {
      const c = await db.accountingConnection.findUniqueOrThrow({ where: { provider: 'xero' } });
      expect(c.accessTokenEnc).not.toContain('access-1');
      expect(c.refreshTokenEnc).not.toContain('refresh-1');
      expect(cipher.decrypt(c.refreshTokenEnc)).toBe('refresh-1');
      expect(c).toMatchObject({ tenantId: 'tenant-demo', tenantName: 'Demo Company (AU)' });
    });

    it('returns the stored token without refreshing while it is fresh', async () => {
      expect(await store().getAccessToken()).toEqual({ accessToken: 'access-1', tenantId: 'tenant-demo' });
      expect(oauth.refreshCalls).toEqual([]);
    });

    it('refreshes before expiry (inside the skew window) and persists the rotated tokens', async () => {
      clock = new Date(Date.now() + 26 * 60_000); // 4 min left < 5 min skew
      expect((await store().getAccessToken()).accessToken).toBe('access-2');
      expect(oauth.refreshCalls).toEqual(['refresh-1']);

      const c = await db.accountingConnection.findUniqueOrThrow({ where: { provider: 'xero' } });
      expect(cipher.decrypt(c.refreshTokenEnc)).toBe('refresh-2');
      expect(c.lastRefreshedAt).toEqual(clock);

      // A brand-new store (e.g. after a restart) reads the refreshed token from the DB.
      expect((await store().getAccessToken()).accessToken).toBe('access-2');
      expect(oauth.refreshCalls).toHaveLength(1);
    });

    it('refreshes exactly once when many requests (or processes) hit an expiring token together', async () => {
      clock = new Date(Date.now() + 29 * 60_000);
      oauth.refreshDelayMs = 50;
      // Separate TokenStore instances = separate processes sharing the database.
      const grants = await Promise.all(Array.from({ length: 6 }, () => store().getAccessToken()));
      expect(oauth.refreshCalls).toEqual(['refresh-1']); // a second refresh would have used a dead token
      expect(new Set(grants.map((g) => g.accessToken))).toEqual(new Set(['access-2']));
    });

    it('a forced refresh after a 401 is skipped if another process already refreshed', async () => {
      const seen = (await db.accountingConnection.findUniqueOrThrow({ where: { provider: 'xero' } })).accessTokenEnc;
      await store().refreshAfterUnauthorized(); // process A
      expect(oauth.refreshCalls).toHaveLength(1);
      const g = await store().refresh(true, seen); // process B, which saw the old token
      expect(g.accessToken).toBe('access-2');
      expect(oauth.refreshCalls).toHaveLength(1);
    });

    it('drops the connection when the refresh token is rejected (invalid_grant)', async () => {
      clock = new Date(Date.now() + 40 * 60_000);
      oauth.invalidGrant = true;
      await expect(store().getAccessToken()).rejects.toBeInstanceOf(NotConnectedError);
      expect(await db.accountingConnection.count()).toBe(0);
      await expect(store().getAccessToken()).rejects.toThrow(/not connected/);
    });

    it('keepAlive refreshes an idle connection after the max age only', async () => {
      expect(await store().keepAlive(7 * 86_400_000)).toBe(false);
      clock = new Date(Date.now() + 8 * 86_400_000);
      expect(await store().keepAlive(7 * 86_400_000)).toBe(true);
      expect(oauth.refreshCalls).toHaveLength(1);
    });

    it('reports status and disconnects', async () => {
      expect(await store().status()).toMatchObject({ connected: true, tenantName: 'Demo Company (AU)' });
      await store().disconnect();
      expect(await store().status()).toMatchObject({ connected: false });
    });
  });

  // ===========================================================================
  describe('PostingService: idempotent posting', () => {
    let xero: FakeAccountingProvider;
    let posting: PostingService;

    beforeEach(() => {
      xero = new FakeAccountingProvider();
      posting = new PostingService(db, xero, { backoff: { baseMs: 1000, maxMs: 60_000 }, random: () => 1 });
    });

    it('posts a draft bill, stores the Xero id, reconciles and ends posted', async () => {
      const id = await seedApproved();
      const r = await posting.post(id);
      expect(r).toMatchObject({ status: 'posted', reused: false, reconcile: { ok: true } });
      expect(xero.createCalls).toHaveLength(1);
      expect(xero.createCalls[0]!.idempotencyKey).toBe(id);

      const inv = await row(id);
      expect(inv).toMatchObject({ status: 'posted', accountingProvider: 'xero', externalId: r.externalId, postAttempts: 1 });
      expect(inv.reconciledAt).toBeInstanceOf(Date);
      expect(await eventTypes(id)).toEqual(['bill_created', 'reconciled']);
    });

    it('re-posting reuses the stored id and never creates a second bill', async () => {
      const id = await seedApproved();
      const first = await posting.post(id);
      // Even if something resets the status, a stored external id short-circuits creation.
      await db.invoice.update({ where: { id }, data: { status: 'approved' } });
      const again = await posting.post(id);
      expect(again).toMatchObject({ externalId: first.externalId, reused: true });
      expect(xero.createCalls).toHaveLength(1);
      expect(xero.bills.size).toBe(1);
    });

    it('serialises concurrent posts of the same invoice (double-click): one bill', async () => {
      const id = await seedApproved();
      xero.createDelayMs = 100;
      const results = await Promise.all(Array.from({ length: 5 }, () => posting.post(id)));
      expect(xero.createCalls).toHaveLength(1);
      expect(new Set(results.map((r) => r.externalId)).size).toBe(1);
      expect(results.filter((r) => !r.reused)).toHaveLength(1);
    });

    it('recovers a bill created by an attempt that crashed before saving the id', async () => {
      const id = await seedApproved();
      xero.crashAfterCreate = true; // bill exists in Xero, our transaction rolled back
      await expect(posting.post(id)).rejects.toThrow(/socket hang up/);
      expect(xero.bills.size).toBe(1);
      expect((await row(id)).externalId).toBeNull();

      const r = await posting.post(id);
      expect(r).toMatchObject({ reused: true, status: 'posted' });
      expect(xero.createCalls).toHaveLength(1); // no second create
      expect((await row(id)).externalId).toBe([...xero.bills.keys()][0]);
      expect(await eventTypes(id)).toContain('bill_recovered');
    });

    it('records a transient failure with backoff for the sweeper, then the sweeper posts it', async () => {
      const id = await seedApproved();
      xero.failCreate = (n) => (n === 1 ? new AccountingError('Xero 503', true, 503) : undefined);

      const before = Date.now();
      await expect(posting.post(id)).rejects.toThrow('Xero 503');
      let inv = await row(id);
      expect(inv).toMatchObject({ status: 'approved', postAttempts: 1, lastError: 'Xero 503', externalId: null });
      expect(inv.nextPostAt!.getTime()).toBeGreaterThanOrEqual(before + 1000);

      expect((await posting.sweep()).posted).toBe(0); // not due yet
      await db.invoice.update({ where: { id }, data: { nextPostAt: new Date(Date.now() - 1) } });
      expect((await posting.sweep()).posted).toBe(1);
      inv = await row(id);
      expect(inv).toMatchObject({ status: 'posted', lastError: null, nextPostAt: null });
      expect(xero.bills.size).toBe(1);
    });

    it('stops automatic retries after max attempts and on non-retryable errors; manual retry resets', async () => {
      const id = await seedApproved();
      xero.failCreate = () => new AccountingError('Account code 999 is not valid', false, 400);
      await expect(posting.post(id)).rejects.toThrow(/Account code/);
      expect(await row(id)).toMatchObject({ status: 'approved', nextPostAt: null, postAttempts: 1 });
      expect((await posting.sweep()).posted).toBe(0);

      xero.failCreate = undefined;
      expect((await posting.retryPost(id)).status).toBe('posted');
    });

    it('refuses to post an invoice that is not approved', async () => {
      const id = await seedApproved();
      await db.invoice.update({ where: { id }, data: { status: 'needs_review' } });
      await expect(posting.post(id)).rejects.toMatchObject({ statusCode: 409 });
      expect(xero.createCalls).toHaveLength(0);
    });

    it('cannot link two of our invoices to the same Xero bill (duplicate supplier invoice)', async () => {
      const a = await seedApproved('first');
      const b = await seedApproved('second'); // same vendor + invoice number, different scan
      await posting.post(a);
      await expect(posting.post(b)).rejects.toThrow(/already linked to another invoice/);
      expect(await row(b)).toMatchObject({ status: 'approved', externalId: null });
      expect(xero.bills.size).toBe(1);
    });
  });

  // ===========================================================================
  describe('PostingService: reconciliation', () => {
    let xero: FakeAccountingProvider;
    let posting: PostingService;

    beforeEach(() => {
      xero = new FakeAccountingProvider();
      posting = new PostingService(db, xero);
    });

    it('flags a bill edited in Xero as mismatch, and re-running after a fix restores posted', async () => {
      const id = await seedApproved();
      const { externalId } = await posting.post(id);

      xero.tamper(externalId, { total: 120, tax: 20 });
      const bad = await posting.reconcile(id);
      expect(bad.ok).toBe(false);
      const inv = await row(id);
      expect(inv.status).toBe('mismatch');
      expect(inv.reconcileResult).toMatchObject({ ok: false, theirs: { total: 120 } });

      xero.tamper(externalId, { total: 110, tax: 10 });
      expect((await posting.reconcile(id)).ok).toBe(true);
      expect((await row(id)).status).toBe('posted');
    });

    it('flags voided and deleted bills', async () => {
      const id = await seedApproved();
      const { externalId } = await posting.post(id);
      xero.tamper(externalId, { status: 'VOIDED' });
      expect((await posting.reconcile(id)).mismatches).toEqual(['status: bill is VOIDED in the accounting system']);
      xero.bills.delete(externalId);
      expect((await posting.reconcile(id)).mismatches[0]).toMatch(/not found/);
    });

    it('is safe to re-run: repeated reconciles never change a matching result or create bills', async () => {
      const id = await seedApproved();
      await posting.post(id);
      for (let i = 0; i < 3; i++) expect((await posting.reconcile(id)).ok).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'posted' });
      expect(xero.createCalls).toHaveLength(1);
    });

    it('a transient read failure leaves the status alone and records the error', async () => {
      const id = await seedApproved();
      await posting.post(id);
      xero.failGet = new AccountingError('Xero 503', true, 503);
      await expect(posting.reconcile(id)).rejects.toMatchObject({ statusCode: 502 });
      const inv = await row(id);
      expect(inv.status).toBe('posted');
      expect(inv.lastError).toMatch(/could not read the bill/);
    });

    it('leaves the invoice submitted when post-time reconcile fails; the sweeper finishes it', async () => {
      const id = await seedApproved();
      xero.failGet = new AccountingError('Xero 503', true, 503);
      const r = await posting.post(id);
      expect(r.status).toBe('submitted');
      expect(r.reconcileError).toMatch(/503/);

      xero.failGet = undefined;
      await db.invoice.update({ where: { id }, data: { postedAt: new Date(Date.now() - 60_000) } });
      expect((await posting.sweep()).reconciled).toBe(1);
      expect((await row(id)).status).toBe('posted');
    });

    it('refuses to reconcile something never posted', async () => {
      const id = await seedApproved();
      await expect(posting.reconcile(id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('reconcileAll checks every posted invoice', async () => {
      const a = await seedApproved('a', reviewedFixture({ invoiceNumber: 'A-1' }));
      const b = await seedApproved('b', reviewedFixture({ invoiceNumber: 'B-1' }));
      await posting.post(a);
      const pb = await posting.post(b);
      xero.tamper(pb.externalId, { total: 1 });
      expect(await posting.reconcileAll()).toEqual({ ok: 1, mismatch: 1, errors: 0 });
    });
  });

  // ===========================================================================
  describe('HTTP: approve → post → reconcile, and the OAuth callback', () => {
    let app: FastifyInstance;
    let xero: FakeAccountingProvider;
    let oauth: FakeOAuthClient;
    let acc: AccountingModule;

    beforeEach(async () => {
      xero = new FakeAccountingProvider();
      oauth = new FakeOAuthClient();
      const tokens = new TokenStore(db, oauth, cipher, { provider: 'xero' });
      acc = {
        providerName: 'xero',
        oauth,
        tokens,
        provider: xero,
        posting: new PostingService(db, xero),
        redirectUri: 'http://localhost:3000/auth/xero/callback',
      };
      app = await buildApp({
        db,
        storage: new MemoryFileStorage(),
        confidenceThreshold: 0.8,
        maxUploadBytes: 1024 * 1024,
        accounting: acc,
      });
    });

    async function connect() {
      const start = await app.inject({ url: '/auth/xero/connect' });
      expect(start.statusCode).toBe(302);
      const state = new URL(start.headers.location as string).searchParams.get('state')!;
      const cookie = String(start.headers['set-cookie']).split(';')[0]!;
      const cb = await app.inject({ url: `/auth/xero/callback?code=abc&state=${state}`, headers: { cookie } });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('/?xero=connected');
    }

    async function seedNeedsReview() {
      const id = await seedApproved('http');
      await db.invoice.update({ where: { id }, data: { status: 'needs_review', reviewed: undefined, approvedAt: null } });
      return id;
    }

    it('completes the OAuth flow and stores the connection', async () => {
      await connect();
      const status = (await app.inject({ url: '/api/accounting/status' })).json();
      expect(status).toMatchObject({ configured: true, connected: true, tenantName: 'Demo Company (AU)' });
    });

    it('rejects a callback whose state does not match the cookie (CSRF)', async () => {
      await app.inject({ url: '/auth/xero/connect' });
      const res = await app.inject({
        url: '/auth/xero/callback?code=abc&state=forged',
        headers: { cookie: 'ib_oauth_state=real' },
      });
      expect(res.statusCode).toBe(400);
      expect(await db.accountingConnection.count()).toBe(0);
    });

    it('approve posts to Xero and reconciles in one go; a double-click creates one bill', async () => {
      await connect();
      const id = await seedNeedsReview();
      const approve = () => app.inject({ method: 'POST', url: `/api/invoices/${id}/approve`, payload: reviewedFixture() });
      const [a, b] = await Promise.all([approve(), approve()]);
      const bodies = [a.json(), b.json()];
      for (const r of [a, b]) expect([200, 409]).toContain(r.statusCode);
      expect(bodies.some((x) => x.status === 'posted')).toBe(true);
      expect(xero.createCalls).toHaveLength(1);
      expect((await row(id)).status).toBe('posted');

      // Clicking again later is a no-op.
      const again = (await approve()).json();
      expect(again).toMatchObject({ alreadyApproved: true, status: 'posted' });
      expect(xero.createCalls).toHaveLength(1);
    });

    it('approval without a Xero connection stands, with a clear postError', async () => {
      const id = await seedNeedsReview();
      const r = (await app.inject({ method: 'POST', url: `/api/invoices/${id}/approve`, payload: reviewedFixture() })).json();
      expect(r).toMatchObject({ status: 'approved', postError: expect.stringMatching(/not connected/) });
      expect(xero.createCalls).toHaveLength(0);
    });

    it('exposes post and reconcile endpoints', async () => {
      await connect();
      const id = await seedApproved('endpoints');
      const posted = (await app.inject({ method: 'POST', url: `/api/invoices/${id}/post` })).json();
      expect(posted).toMatchObject({ status: 'posted', reused: false });
      const rec = (await app.inject({ method: 'POST', url: `/api/invoices/${id}/reconcile` })).json();
      expect(rec).toMatchObject({ status: 'posted', result: { ok: true } });
      expect((await app.inject({ method: 'POST', url: '/api/invoices/nope/post' })).statusCode).toBe(400);
    });

    it('reports not configured when there is no accounting module', async () => {
      const bare = await buildApp({ db, storage: new MemoryFileStorage(), confidenceThreshold: 0.8, maxUploadBytes: 1024 });
      expect((await bare.inject({ url: '/api/accounting/status' })).json()).toMatchObject({ configured: false });
      expect((await bare.inject({ url: '/auth/xero/connect' })).statusCode).toBe(503);
    });
  });
});
