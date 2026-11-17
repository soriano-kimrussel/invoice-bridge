import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AccountingModule } from './accounting/index.js';
import { accountingRoutes } from './accounting/routes.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { invoiceRoutes } from './invoices/routes.js';
import { InvoiceService } from './invoices/service.js';
import type { FileStorage } from './storage/types.js';

export type AppDeps = {
  db: Db;
  storage: FileStorage;
  confidenceThreshold: number;
  maxUploadBytes: number;
  /** Extraction attempts per invoice before it is marked failed. */
  maxAttempts?: number;
  /** Built React app (web/dist). Served with SPA fallback when present. */
  webRoot?: string;
  logger?: FastifyServerOptions['logger'];
  /** Accounting integration (Xero). Absent when not configured: approval still works, posting is unavailable. */
  accounting?: AccountingModule;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });

  await app.register(multipart, {
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 5 },
  });
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'bad_request', message: err.issues[0]?.message, details: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'internal server error' });
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.db.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  const service = new InvoiceService(deps.db, deps.storage, {
    confidenceThreshold: deps.confidenceThreshold,
    maxAttempts: deps.maxAttempts,
  });
  await app.register(invoiceRoutes, { service, accounting: deps.accounting });
  await app.register(accountingRoutes, { accounting: deps.accounting });

  if (deps.webRoot && existsSync(path.join(deps.webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(deps.webRoot), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/auth/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: `route ${req.method} ${req.url} not found` });
    });
  }

  return app;
}
