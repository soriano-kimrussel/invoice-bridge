import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountingStatusDto } from '../domain/api.js';
import { AppError, badRequest } from '../errors.js';
import type { AccountingModule } from './index.js';

const STATE_COOKIE = 'ib_oauth_state';
const idParams = z.object({ id: z.uuid('invalid invoice id') });

const notConfigured = () =>
  new AppError(503, 'accounting_not_configured', 'Xero is not configured (set XERO_* and TOKEN_ENCRYPTION_KEY)');

export async function accountingRoutes(app: FastifyInstance, opts: { accounting?: AccountingModule }) {
  const acc = opts.accounting;

  app.get('/api/accounting/status', async (): Promise<AccountingStatusDto> => {
    if (!acc) {
      return { provider: 'xero', configured: false, connected: false, tenantId: null, tenantName: null, accessTokenExpiresAt: null };
    }
    const s = await acc.tokens.status();
    return {
      provider: acc.providerName,
      configured: true,
      connected: s.connected,
      tenantId: s.tenantId,
      tenantName: s.tenantName,
      accessTokenExpiresAt: s.accessTokenExpiresAt?.toISOString() ?? null,
    };
  });

  app.post('/api/accounting/disconnect', async () => {
    if (!acc) throw notConfigured();
    await acc.tokens.disconnect();
    return { connected: false };
  });

  // ---- OAuth2 Authorization Code flow -------------------------------------

  app.get('/auth/xero/connect', async (_req, reply) => {
    if (!acc) throw notConfigured();
    const state = randomBytes(24).toString('base64url');
    const secure = acc.redirectUri.startsWith('https://');
    reply.setCookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure, path: '/auth/xero', maxAge: 600 });
    return reply.redirect(await acc.oauth.consentUrl(state));
  });

  app.get('/auth/xero/callback', async (req, reply) => {
    if (!acc) throw notConfigured();
    const q = req.query as Record<string, string | undefined>;
    const expected = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/auth/xero' });

    if (q.error) return reply.redirect(`/?xero=${encodeURIComponent(q.error)}`);
    if (!q.state || !expected || !safeEqual(q.state, expected)) {
      throw badRequest('OAuth state mismatch: start again from "Connect Xero"');
    }

    // Rebuild the callback URL on the registered redirect URI (exactly what Xero redirected to).
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const { tokens, tenants } = await acc.oauth.exchangeCode(`${acc.redirectUri}${query}`, expected);
    const tenant = acc.preferredTenantId ? tenants.find((t) => t.tenantId === acc.preferredTenantId) : tenants[0];
    if (!tenant) throw badRequest('No Xero organisation was granted (or XERO_TENANT_ID is not among them).');

    await acc.tokens.saveConnection(tokens, tenant);
    req.log.info({ tenantId: tenant.tenantId, tenantName: tenant.tenantName }, 'connected to Xero');
    return reply.redirect('/?xero=connected');
  });

  // ---- posting & reconciliation -------------------------------------------

  app.post('/api/invoices/:id/post', async (req) => {
    if (!acc) throw notConfigured();
    const { id } = idParams.parse(req.params);
    const r = await acc.posting.retryPost(id);
    return { id, status: r.status, externalId: r.externalId, reused: r.reused, reconcileError: r.reconcileError };
  });

  app.post('/api/invoices/:id/reconcile', async (req) => {
    if (!acc) throw notConfigured();
    const { id } = idParams.parse(req.params);
    const result = await acc.posting.reconcile(id);
    return { id, status: result.ok ? 'posted' : 'mismatch', result };
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
