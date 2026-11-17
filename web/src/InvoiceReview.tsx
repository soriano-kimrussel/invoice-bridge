import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountingStatusDto, InvoiceDetailDto } from '../../src/domain/api.js';
import {
  arithmeticIssues,
  toCents,
  type ExtractedField,
  type ExtractedInvoice,
  type ReviewDraft,
  type ReviewedInvoice,
} from '../../src/domain/invoice.js';
import { api, ApiError } from './api.js';
import { pct, STATUS_LABEL, when } from './format.js';
import { StatusPill } from './Queue.js';
import { navigate } from './router.js';

// ---------------------------------------------------------------------------
// Form state: strings while editing, converted to numbers only on save.
// ---------------------------------------------------------------------------

type LineForm = { description: string; quantity: string; unitPrice: string; amount: string };
type FormState = {
  vendorName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  lineItems: LineForm[];
};

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const num = (v: string): number | null => {
  const t = v.replace(/[,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const fromCents = (c: number) => (c / 100).toFixed(2);

function toForm(d: ReviewDraft): FormState {
  return {
    vendorName: s(d.vendorName),
    invoiceNumber: s(d.invoiceNumber),
    issueDate: s(d.issueDate),
    dueDate: s(d.dueDate),
    currency: s(d.currency),
    subtotal: s(d.subtotal),
    tax: s(d.tax),
    total: s(d.total),
    lineItems: (d.lineItems ?? []).map((li) => ({
      description: li.description,
      quantity: s(li.quantity),
      unitPrice: s(li.unitPrice),
      amount: s(li.amount),
    })),
  };
}

function toDraft(f: FormState): ReviewDraft {
  const n = (v: string) => {
    const x = num(v);
    return x === null || Number.isNaN(x) ? null : x;
  };
  const str = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    vendorName: str(f.vendorName),
    invoiceNumber: str(f.invoiceNumber),
    issueDate: str(f.issueDate),
    dueDate: str(f.dueDate),
    currency: str(f.currency)?.toUpperCase() ?? null,
    subtotal: n(f.subtotal),
    tax: n(f.tax),
    total: n(f.total),
    lineItems: f.lineItems.map((li) => ({
      description: li.description.trim(),
      quantity: n(li.quantity) ?? 0,
      unitPrice: n(li.unitPrice) ?? 0,
      amount: n(li.amount) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------

export function InvoiceReview({ id, accounting }: { id: string; accounting: AccountingStatusDto | null }) {
  const [detail, setDetail] = useState<InvoiceDetailDto | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    async (resetForm: boolean) => {
      try {
        const d = await api.get(id);
        setDetail(d);
        if (resetForm) {
          setForm(toForm(d.form));
          setDirty(false);
        }
        setLoadError(null);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    },
    [id],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Keep polling while the invoice is moving through the pipeline on its own.
  const status = detail?.invoice.status;
  useEffect(() => {
    if (status !== 'pending' && status !== 'processing') return;
    const t = setInterval(() => void load(true), 2500);
    return () => clearInterval(t);
  }, [status, load]);

  const editable = status === 'needs_review';

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };

  const updateLine = (i: number, patch: Partial<LineForm>) => {
    setForm((f) => {
      if (!f) return f;
      const lines = f.lineItems.map((li, j) => {
        if (j !== i) return li;
        const next = { ...li, ...patch };
        // Quantity × unit price drives the line amount, computed in integer cents.
        if ('quantity' in patch || 'unitPrice' in patch) {
          const q = num(next.quantity);
          const u = num(next.unitPrice);
          if (q !== null && u !== null && !Number.isNaN(q) && !Number.isNaN(u)) {
            next.amount = fromCents(Math.round(q * toCents(u)));
          }
        }
        return next;
      });
      return { ...f, lineItems: lines };
    });
    setDirty(true);
  };

  const checks = useMemo(() => (form ? liveChecks(form) : []), [form]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setBanner(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError) {
        setFieldErrors(e.fieldErrors());
        setBanner({ tone: 'bad', text: e.message });
      } else {
        setBanner({ tone: 'bad', text: (e as Error).message });
      }
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run('save', async () => {
      const d = await api.saveDraft(id, toDraft(form!));
      setDetail(d);
      setForm(toForm(d.form));
      setDirty(false);
      setFieldErrors({});
      setBanner({ tone: 'ok', text: 'Draft saved.' });
    });

  const approve = () =>
    run('approve', async () => {
      const r = await api.approve(id, toDraft(form!) as ReviewedInvoice);
      setFieldErrors({});
      await load(true);
      if (r.postError) setBanner({ tone: 'bad', text: `Approved, but posting to Xero failed: ${r.postError}` });
      else if (r.alreadyApproved) setBanner({ tone: 'info', text: 'This invoice was already approved.' });
      else setBanner({ tone: 'ok', text: `Approved (${STATUS_LABEL[r.status]}).` });
    });

  const reject = () => {
    const reason = prompt('Reason for rejecting this invoice?');
    if (!reason?.trim()) return;
    return run('reject', async () => {
      await api.reject(id, reason);
      await load(true);
      setBanner({ tone: 'info', text: 'Invoice rejected.' });
    });
  };

  const action = (label: string, fn: () => Promise<unknown>, ok: string) =>
    run(label, async () => {
      await fn();
      await load(true);
      setBanner({ tone: 'ok', text: ok });
    });

  if (loadError) {
    return (
      <div className="banner error">
        Could not load invoice: {loadError}{' '}
        <button className="link" onClick={() => navigate('/')}>
          Back to queue
        </button>
      </div>
    );
  }
  if (!detail || !form) return <div className="empty">Loading…</div>;

  const inv = detail.invoice;
  const ex = detail.extracted;
  const low = new Set(detail.lowConfidence);
  const fieldProps = (key: keyof ExtractedInvoice & keyof FormState) => ({
    field: ex?.[key] as ExtractedField<unknown> | undefined,
    low: low.has(key),
    error: fieldErrors[key],
    disabled: !editable,
  });

  return (
    <div className="review">
      <div className="review-head">
        <button className="btn ghost" onClick={() => navigate('/')}>
          ← Queue
        </button>
        <h1>
          {form.vendorName || 'Unknown vendor'} <span className="muted">{form.invoiceNumber}</span>
        </h1>
        <StatusPill status={inv.status} />
      </div>

      {banner && <div className={`banner ${banner.tone === 'bad' ? 'error' : banner.tone}`}>{banner.text}</div>}

      <div className="split">
        <section className="viewer" aria-label="Original document">
          <div className="viewer-bar">
            <span className="muted small">{inv.originalFilename}</span>
            <a className="link small" href={api.fileUrl(id)} target="_blank" rel="noreferrer">
              Open in new tab ↗
            </a>
          </div>
          {inv.mimeType === 'application/pdf' ? (
            <iframe title="Invoice PDF" src={`${api.fileUrl(id)}#view=FitH`} />
          ) : (
            <div className="image-wrap">
              <img alt="Invoice" src={api.fileUrl(id)} />
            </div>
          )}
        </section>

        <section className="fields" aria-label="Extracted fields">
          <PipelinePanel
            detail={detail}
            accounting={accounting}
            busy={busy}
            onRetry={() => action('retry', () => api.retry(id), 'Re-queued for extraction.')}
            onPost={() => action('post', () => api.post(id), 'Posted to Xero.')}
            onReconcile={() => action('reconcile', () => api.reconcile(id), 'Reconciliation complete.')}
          />

          {ex && editable && low.size > 0 && (
            <p className="hint">
              <span className="swatch" /> Highlighted fields were read with less than {pct(detail.confidenceThreshold)}{' '}
              confidence. Check them against the document.
            </p>
          )}

          <fieldset disabled={!editable || busy !== null}>
            <div className="grid">
              <Field label="Vendor" wide {...fieldProps('vendorName')}>
                <input value={form.vendorName} onChange={(e) => update({ vendorName: e.target.value })} />
              </Field>
              <Field label="Invoice number" {...fieldProps('invoiceNumber')}>
                <input value={form.invoiceNumber} onChange={(e) => update({ invoiceNumber: e.target.value })} />
              </Field>
              <Field label="Currency" {...fieldProps('currency')}>
                <input
                  value={form.currency}
                  maxLength={3}
                  placeholder="AUD"
                  onChange={(e) => update({ currency: e.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Issue date" {...fieldProps('issueDate')}>
                <input type="date" value={form.issueDate} onChange={(e) => update({ issueDate: e.target.value })} />
              </Field>
              <Field label="Due date" {...fieldProps('dueDate')}>
                <input type="date" value={form.dueDate} onChange={(e) => update({ dueDate: e.target.value })} />
              </Field>
            </div>

            <h2>Line items</h2>
            <table className="lines">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {form.lineItems.map((li, i) => {
                  const exLine = ex?.lineItems[i];
                  const cell = (k: keyof LineForm) => ({
                    className: [
                      low.has(`lineItems.${i}.${k}`) ? 'low' : '',
                      fieldErrors[`lineItems.${i}.${k}`] ? 'invalid' : '',
                    ].join(' '),
                    title: [
                      exLine ? `confidence ${pct(exLine[k].confidence)}` : 'added by reviewer',
                      fieldErrors[`lineItems.${i}.${k}`] ?? '',
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  });
                  return (
                    <tr key={i}>
                      <td {...cell('description')}>
                        <input value={li.description} onChange={(e) => updateLine(i, { description: e.target.value })} />
                      </td>
                      <td {...cell('quantity')}>
                        <input inputMode="decimal" className="num" value={li.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} />
                      </td>
                      <td {...cell('unitPrice')}>
                        <input inputMode="decimal" className="num" value={li.unitPrice} onChange={(e) => updateLine(i, { unitPrice: e.target.value })} />
                      </td>
                      <td {...cell('amount')}>
                        <input inputMode="decimal" className="num" value={li.amount} onChange={(e) => updateLine(i, { amount: e.target.value })} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn icon ghost"
                          aria-label={`Remove line ${i + 1}`}
                          onClick={() => {
                            update({ lineItems: form.lineItems.filter((_, j) => j !== i) });
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {fieldErrors.lineItems && <div className="error-text">{fieldErrors.lineItems}</div>}
            <button
              type="button"
              className="btn small ghost"
              onClick={() =>
                update({ lineItems: [...form.lineItems, { description: '', quantity: '1', unitPrice: '', amount: '' }] })
              }
            >
              + Add line
            </button>

            <div className="totals">
              <Field label="Subtotal" {...fieldProps('subtotal')}>
                <input inputMode="decimal" className="num" value={form.subtotal} onChange={(e) => update({ subtotal: e.target.value })} />
              </Field>
              <Field label="Tax" {...fieldProps('tax')}>
                <input inputMode="decimal" className="num" value={form.tax} onChange={(e) => update({ tax: e.target.value })} />
              </Field>
              <Field label="Total" {...fieldProps('total')}>
                <input inputMode="decimal" className="num" value={form.total} onChange={(e) => update({ total: e.target.value })} />
              </Field>
            </div>

            {checks.length > 0 && editable && (
              <div className="checks">
                {checks.map((c) => (
                  <div key={c.path} className="check">
                    ⚠ {c.message}
                    {c.fix && (
                      <button type="button" className="btn small ghost" onClick={() => update(c.fix!)}>
                        {c.fixLabel}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          {editable && (
            <div className="actions">
              <button className="btn danger ghost" onClick={reject} disabled={busy !== null}>
                Reject
              </button>
              <span className="spacer" />
              <button className="btn" onClick={save} disabled={busy !== null || !dirty}>
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </button>
              <button
                className="btn primary"
                onClick={approve}
                disabled={busy !== null || checks.length > 0}
                title={checks.length ? 'Fix the totals first' : 'Approve and post to accounting'}
              >
                {busy === 'approve' ? 'Approving…' : accounting?.connected ? 'Approve & post to Xero' : 'Approve'}
              </button>
            </div>
          )}

          <History events={detail.events} />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label,
  field,
  low,
  error,
  wide,
  children,
}: {
  label: string;
  field?: ExtractedField<unknown>;
  low: boolean;
  error?: string;
  disabled?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`field ${low ? 'low' : ''} ${error ? 'invalid' : ''} ${wide ? 'wide' : ''}`}>
      <span className="field-label">
        {label}
        {field && (
          <span
            className={`conf ${low ? 'low' : ''}`}
            title={field.value === null ? 'Not found on the document' : 'Model confidence'}
          >
            {field.value === null ? 'not found' : pct(field.confidence)}
          </span>
        )}
      </span>
      {children}
      {error && <span className="error-text">{error}</span>}
    </label>
  );
}

type Check = { path: string; message: string; fix?: Partial<FormState>; fixLabel?: string };

/** Same arithmetic the server enforces on approve, run as you type, with one-click fixes. */
function liveChecks(f: FormState): Check[] {
  const amounts = f.lineItems.map((li) => num(li.amount));
  const subtotal = num(f.subtotal);
  const tax = num(f.tax);
  const total = num(f.total);
  const known = (n: number | null): n is number => n !== null && !Number.isNaN(n);
  if (!amounts.every(known) || !known(subtotal) || !known(tax) || !known(total)) return [];

  const lineSum = amounts.reduce((a, n) => a + toCents(n), 0);
  return arithmeticIssues({ subtotal, tax, total, lineItems: amounts.map((amount) => ({ amount })) }).map(
    (issue): Check =>
      issue.path === 'subtotal'
        ? { ...issue, fix: { subtotal: fromCents(lineSum) }, fixLabel: 'Use line total' }
        : { ...issue, fix: { total: fromCents(toCents(subtotal) + toCents(tax)) }, fixLabel: 'Use subtotal + tax' },
  );
}

function PipelinePanel({
  detail,
  accounting,
  busy,
  onRetry,
  onPost,
  onReconcile,
}: {
  detail: InvoiceDetailDto;
  accounting: AccountingStatusDto | null;
  busy: string | null;
  onRetry: () => void;
  onPost: () => void;
  onReconcile: () => void;
}) {
  const inv = detail.invoice;
  switch (inv.status) {
    case 'pending':
    case 'processing':
      return (
        <div className="panel info">
          <strong>{inv.status === 'pending' ? 'Queued for extraction' : 'Extracting with Azure Document Intelligence…'}</strong>
          {inv.attempts > 0 && (
            <div className="small">
              Attempt {inv.attempts} of {inv.maxAttempts}
              {inv.lastError && <> · last error: {inv.lastError}</>}
            </div>
          )}
        </div>
      );
    case 'failed':
      return (
        <div className="panel bad">
          <strong>Extraction failed after {inv.attempts} attempt(s)</strong>
          <div className="small mono">{inv.lastError}</div>
          <button className="btn small" onClick={onRetry} disabled={busy !== null}>
            Retry extraction
          </button>
        </div>
      );
    case 'approved':
      return (
        <div className="panel info">
          <strong>Approved by {inv.reviewedBy ?? 'a reviewer'}</strong>, not yet in Xero.
          {inv.lastError && <div className="small mono">Last posting error: {inv.lastError}</div>}
          <button className="btn small primary" onClick={onPost} disabled={busy !== null || !accounting?.connected}>
            {busy === 'post' ? 'Posting…' : 'Post to Xero'}
          </button>
          {!accounting?.connected && <div className="small">Connect Xero (top right) to post.</div>}
        </div>
      );
    case 'submitted':
    case 'posted':
    case 'mismatch': {
      const rr = inv.reconcileResult;
      return (
        <div className={`panel ${inv.status === 'posted' ? 'ok' : inv.status === 'mismatch' ? 'bad' : 'info'}`}>
          <strong>
            {inv.status === 'posted'
              ? 'Posted to Xero and reconciled'
              : inv.status === 'mismatch'
                ? 'Xero does not match our record'
                : 'Sent to Xero, awaiting reconciliation'}
          </strong>
          <div className="small">
            Xero InvoiceID <span className="mono">{inv.externalId}</span>
            {inv.reconciledAt && <> · checked {when(inv.reconciledAt)}</>}
          </div>
          {rr && rr.mismatches.length > 0 && (
            <ul className="small">
              {rr.mismatches.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          {inv.lastError && <div className="small mono">{inv.lastError}</div>}
          <button className="btn small" onClick={onReconcile} disabled={busy !== null || !accounting?.connected}>
            {busy === 'reconcile' ? 'Checking…' : 'Re-run reconciliation'}
          </button>
        </div>
      );
    }
    case 'rejected':
      return <div className="panel muted">Rejected by {inv.reviewedBy ?? 'a reviewer'}.</div>;
    default:
      return null;
  }
}

function History({ events }: { events: InvoiceDetailDto['events'] }) {
  return (
    <details className="history">
      <summary>History ({events.length})</summary>
      <ol>
        {events
          .slice()
          .reverse()
          .map((e) => (
            <li key={e.id}>
              <span className="mono small">{e.type}</span> {e.message}{' '}
              <span className="muted small" title={e.createdAt}>
                {when(e.createdAt)}
              </span>
            </li>
          ))}
      </ol>
    </details>
  );
}
