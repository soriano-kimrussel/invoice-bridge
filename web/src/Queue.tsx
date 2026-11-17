import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvoiceSummaryDto } from '../../src/domain/api.js';
import type { InvoiceStatusValue } from '../../src/domain/invoice.js';
import { api, ApiError } from './api.js';
import { money, STATUS_LABEL, when } from './format.js';
import { navigate } from './router.js';

const TABS: { key: string; label: string; statuses: InvoiceStatusValue[] }[] = [
  { key: 'review', label: 'Needs review', statuses: ['needs_review'] },
  { key: 'processing', label: 'Extracting', statuses: ['pending', 'processing'] },
  { key: 'accounting', label: 'Approved', statuses: ['approved', 'submitted'] },
  { key: 'posted', label: 'Posted', statuses: ['posted'] },
  { key: 'attention', label: 'Attention', statuses: ['failed', 'mismatch'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
];

const POLL_MS = 3000;

export function Queue({ tab }: { tab: string | null }) {
  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  const [items, setItems] = useState<InvoiceSummaryDto[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<InvoiceStatusValue, number>>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, c] = await Promise.all([api.list(active.statuses), api.counts()]);
      setItems(list.items);
      setCounts(c);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [active.statuses]);

  useEffect(() => {
    setItems(null);
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="queue">
      <Uploader onUploaded={load} />

      <nav className="tabs" role="tablist">
        {TABS.map((t) => {
          const n = t.statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={t.key === active.key}
              className={`tab ${t.key === active.key ? 'active' : ''} ${t.key === 'attention' && n > 0 ? 'warn' : ''}`}
              onClick={() => navigate(t.key === 'review' ? '/' : `/?tab=${t.key}`)}
            >
              {t.label}
              <span className="count">{n}</span>
            </button>
          );
        })}
      </nav>

      {error && <div className="banner error">Could not load invoices: {error}</div>}

      {items === null ? (
        <div className="empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          {active.key === 'review' ? 'Nothing waiting for review. Upload an invoice to get started.' : 'Nothing here.'}
        </div>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Invoice #</th>
              <th className="num">Total</th>
              <th>Status</th>
              <th>Flags</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} onClick={() => navigate(`/invoices/${i.id}`)} tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/invoices/${i.id}`)}>
                <td>
                  <div className="strong">{i.vendorName ?? <span className="muted">Unknown vendor</span>}</div>
                  <div className="muted small">{i.originalFilename}</div>
                </td>
                <td>{i.invoiceNumber ?? <span className="muted">—</span>}</td>
                <td className="num">{money(i.total, i.currency)}</td>
                <td>
                  <StatusPill status={i.status} />
                </td>
                <td>
                  {i.lowConfidenceCount > 0 && i.status === 'needs_review' && (
                    <span className="pill warn">{i.lowConfidenceCount} low confidence</span>
                  )}
                  {i.status === 'pending' && i.attempts > 0 && (
                    <span className="pill warn" title={i.lastError ?? ''}>retry #{i.attempts}</span>
                  )}
                  {i.status === 'failed' && <span className="pill bad" title={i.lastError ?? ''}>{truncate(i.lastError, 40)}</span>}
                </td>
                <td className="muted">{when(i.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: InvoiceStatusValue }) {
  const tone =
    status === 'posted' ? 'ok' : status === 'failed' || status === 'mismatch' ? 'bad' : status === 'needs_review' ? 'warn' : 'info';
  return <span className={`pill ${tone}`}>{STATUS_LABEL[status]}</span>;
}

const truncate = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

function Uploader({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [messages, setMessages] = useState<{ text: string; tone: 'ok' | 'bad' | 'info'; id?: string }[]>([]);

  async function uploadAll(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      try {
        const r = await api.upload(file);
        setMessages((m) => [
          {
            text: r.duplicate ? `${file.name}: identical file already uploaded; no duplicate created` : `${file.name}: queued for extraction`,
            tone: r.duplicate ? 'info' : 'ok',
            id: r.id,
          },
          ...m.slice(0, 4),
        ]);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        setMessages((m) => [{ text: `${file.name}: ${msg}`, tone: 'bad' }, ...m.slice(0, 4)]);
      }
    }
    onUploaded();
  }

  return (
    <section>
      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void uploadAll(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      >
        <strong>Drop supplier invoices here</strong> or click to choose. PDF, PNG, JPEG or TIFF
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/tiff,image/bmp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void uploadAll(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {messages.length > 0 && (
        <ul className="upload-log">
          {messages.map((m, i) => (
            <li key={i} className={m.tone}>
              {m.text}
              {m.id && (
                <button className="link" onClick={() => navigate(`/invoices/${m.id}`)}>
                  open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
