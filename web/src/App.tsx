import { useEffect, useState } from 'react';
import type { AccountingStatusDto } from '../../src/domain/api.js';
import { api, getReviewer, setReviewer } from './api.js';
import { InvoiceReview } from './InvoiceReview.js';
import { Queue } from './Queue.js';
import { navigate, useRoute } from './router.js';

export function App() {
  const route = useRoute();
  const [accounting, setAccounting] = useState<AccountingStatusDto | null>(null);
  const [reviewer, setReviewerState] = useState(getReviewer);

  const refreshAccounting = () =>
    api
      .accountingStatus()
      .then(setAccounting)
      .catch(() => setAccounting(null));

  // Result of the OAuth redirect (/?xero=connected or /?xero=<error>), shown once.
  const [oauthResult] = useState(() => new URLSearchParams(window.location.search).get('xero'));
  useEffect(() => {
    void refreshAccounting();
    if (oauthResult) window.history.replaceState(null, '', '/');
  }, [oauthResult]);

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          <span className="logo" aria-hidden>
            ⇄
          </span>
          Invoice Bridge
        </a>
        <div className="topbar-right">
          <label className="reviewer">
            <span>Reviewer</span>
            <input
              value={reviewer}
              placeholder="Your name"
              onChange={(e) => {
                setReviewerState(e.target.value);
                setReviewer(e.target.value);
              }}
            />
          </label>
          <XeroBadge status={accounting} onChange={refreshAccounting} />
        </div>
      </header>
      <main>
        {oauthResult && (
          <div className={`banner ${oauthResult === 'connected' ? 'ok' : 'error'}`}>
            {oauthResult === 'connected'
              ? 'Connected to Xero. Approved invoices will now be posted as draft bills.'
              : `Xero connection was not completed (${oauthResult}).`}
          </div>
        )}
        {route.name === 'invoice' ? (
          <InvoiceReview key={route.id} id={route.id} accounting={accounting} />
        ) : (
          <Queue tab={route.tab} />
        )}
      </main>
    </div>
  );
}

function XeroBadge({ status, onChange }: { status: AccountingStatusDto | null; onChange: () => void }) {
  if (!status) return <span className="pill muted">Accounting: unavailable</span>;
  if (!status.configured) return <span className="pill muted" title="Set XERO_CLIENT_ID / XERO_CLIENT_SECRET">Xero not configured</span>;
  if (!status.connected) {
    return (
      <a className="btn small primary" href="/auth/xero/connect">
        Connect Xero
      </a>
    );
  }
  return (
    <span className="xero-connected">
      <span className="pill ok" title={`Tenant ${status.tenantId}`}>
        ● Xero: {status.tenantName ?? 'connected'}
      </span>
      <button
        className="btn small ghost"
        onClick={async () => {
          if (confirm('Disconnect from Xero? Stored tokens will be deleted.')) {
            await api.disconnect();
            onChange();
          }
        }}
      >
        Disconnect
      </button>
    </span>
  );
}
