import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountingModule } from '../accounting/index.js';
import type { ApproveResponseDto } from '../domain/api.js';
import { INVOICE_STATUSES } from '../domain/invoice.js';
import { badRequest } from '../errors.js';
import type { InvoiceService } from './service.js';

const idParams = z.object({ id: z.uuid('invalid invoice id') });

const listQuery = z.object({
  /** Comma-separated, e.g. `?status=needs_review,failed` */
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()) : undefined))
    .pipe(z.array(z.enum(INVOICE_STATUSES)).optional()),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
});

const rejectBody = z.object({ reason: z.string().min(1).max(1000) });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'invalid request', r.error.issues);
  return r.data;
}

/**
 * There is no login in this portfolio build. The UI sends a reviewer name in
 * this header so the audit trail records who approved what; in a real
 * deployment this would come from Entra ID / Easy Auth.
 */
const reviewerOf = (req: FastifyRequest): string | undefined => {
  const v = req.headers['x-reviewer'];
  const name = (Array.isArray(v) ? v[0] : v)?.trim();
  return name ? name.slice(0, 100) : undefined;
};

export async function invoiceRoutes(
  app: FastifyInstance,
  opts: { service: InvoiceService; accounting?: AccountingModule },
) {
  const { service, accounting } = opts;

  app.post('/api/invoices', async (req, reply) => {
    if (!req.isMultipart()) throw badRequest('expected multipart/form-data with a "file" field');
    const file = await req.file();
    if (!file) throw badRequest('missing "file" field');
    const data = await file.toBuffer(); // throws 413 when over the configured limit
    const { invoice, duplicate } = await service.upload({ data, filename: file.filename });
    return reply.code(duplicate ? 200 : 201).send({ id: invoice.id, status: invoice.status, duplicate });
  });

  app.get('/api/invoices', async (req) => service.list(parse(listQuery, req.query)));

  app.get('/api/invoices/counts', async () => service.counts());

  app.get('/api/invoices/:id', async (req) => service.get(parse(idParams, req.params).id));

  app.get('/api/invoices/:id/file', async (req, reply) => {
    const { data, mimeType, filename } = await service.getFile(parse(idParams, req.params).id);
    return reply
      .header('content-type', mimeType)
      .header('content-disposition', `inline; filename="${filename.replace(/"/g, '')}"`)
      .header('cache-control', 'private, max-age=3600, immutable') // content-addressed
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });

  app.put('/api/invoices/:id/review', async (req) =>
    service.saveDraft(parse(idParams, req.params).id, req.body, reviewerOf(req)),
  );

  /**
   * Approve, then immediately post to accounting when connected. Posting is
   * idempotent (see PostingService), so a double-click or client retry that
   * lands here twice still yields one bill. If posting fails the approval
   * stands; the invoice stays 'approved' with the error and the sweeper retries.
   */
  app.post('/api/invoices/:id/approve', async (req): Promise<ApproveResponseDto> => {
    const { invoice, alreadyApproved } = await service.approve(
      parse(idParams, req.params).id,
      req.body,
      reviewerOf(req),
    );
    let status = invoice.status;
    let postError: string | undefined;
    if (status === 'approved' && accounting) {
      if (!(await accounting.tokens.status()).connected) {
        postError = 'Xero is not connected. Connect it, then use "Post to Xero".';
      } else {
        try {
          status = (await accounting.posting.post(invoice.id)).status;
        } catch (err) {
          postError = (err as Error).message;
        }
      }
    }
    return { id: invoice.id, status, alreadyApproved, ...(postError ? { postError } : {}) };
  });

  app.post('/api/invoices/:id/reject', async (req) => {
    const { reason } = parse(rejectBody, req.body);
    const invoice = await service.reject(parse(idParams, req.params).id, reason, reviewerOf(req));
    return { id: invoice.id, status: invoice.status };
  });

  app.post('/api/invoices/:id/retry', async (req) => {
    const invoice = await service.retry(parse(idParams, req.params).id);
    return { id: invoice.id, status: invoice.status };
  });
}
