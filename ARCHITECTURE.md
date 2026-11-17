# Architecture: idempotency, retries, reconciliation

invoice-bridge moves a supplier invoice through four layers with typed boundaries between them:

```
upload ─► extraction ─────────────► review ──────────────► accounting
          InvoiceExtractor          ReviewDraft →          AccountingProvider
          (Azure DI) →              ReviewedInvoice        (Xero) → ExternalBill
          ExtractedInvoice          (zod-validated)
```

`src/domain/invoice.ts` defines those shapes once (zod schemas, imported by both the server and the React UI). The extraction layer only produces `ExtractedInvoice` (values plus per-field confidence), the review layer only turns it into a `ReviewedInvoice` that passes arithmetic checks, and the accounting layer only consumes `ReviewedInvoice`. Xero lives behind `AccountingProvider` (`createBill`, `findOwnBill`, `getBill`), so a MYOB provider means one new class and no changes elsewhere. Every state change also appends a row to `invoice_events`, which doubles as the audit trail.

## Idempotency

The pipeline is built so that every step can be repeated without side effects, because in practice everything gets repeated: users double-click, browsers retry, workers crash, and networks drop responses after the server already acted.

**Upload** is keyed on the SHA-256 of the file bytes. `content_hash` is `UNIQUE`; uploading the same file again returns the existing invoice, and two simultaneous uploads race on the constraint, with the loser returning the winner's row. Files are stored under `<hash>.<ext>`, so writing the same object twice is harmless, and the file is written *before* the row exists so a worker can never claim an invoice without its file.

**Review actions** are compare-and-set updates (`UPDATE … WHERE id = $1 AND status = 'needs_review'`). Approving twice gives one approval: the second click either sees the invoice already approved (and reports `alreadyApproved`) or loses the compare-and-set.

**Posting** has five layers. Our invoice id is the idempotency key throughout.
1. The whole post runs inside `SELECT … FOR UPDATE` on the invoice row, so a double-click, a client retry and the background sweeper are serialised per invoice.
2. Inside the lock, a stored `external_id` short-circuits everything, so we never call `createBill` for an invoice that already has a bill.
3. Before creating a bill we ask the provider for one *this app* already created for the same supplier and invoice number (Xero `createdByMyApp`). That recovers the nasty case where Xero created the bill but our process died, or the response was lost, before we committed its id: we adopt that bill instead of making a second one.
4. Our invoice id is also sent as Xero's `Idempotency-Key` header.
5. `UNIQUE (accounting_provider, external_id)` makes it impossible for two of our invoices to point at the same bill, which also surfaces duplicate supplier invoices uploaded as different scans.

## Retries and the "failed" state

**Extraction** is a Postgres queue. A worker claims due rows with a single statement, `UPDATE … FROM (SELECT … WHERE status = 'pending' AND next_attempt_at <= now() … FOR UPDATE SKIP LOCKED LIMIT n)`. That sets `processing`, records which worker took the row, and increments `attempts`. `SKIP LOCKED` means any number of workers poll concurrently, never block on each other, and each invoice goes to exactly one of them. The claim commits immediately, so the slow Azure call holds no transaction. Errors are classified:
- **Retryable:** 408, 429, 5xx, network errors and timeouts. These go back to `pending` with exponential backoff and jitter (`next_attempt_at`).
- **Permanent:** other 4xx, unreadable content, output that fails the zod schema, a missing file. These go straight to `failed`.

An invoice that exhausts `max_attempts` also becomes `failed`, with `last_error` and an event; a human can re-queue it from the UI. If a worker crashes, its claim expires after `WORKER_LEASE_SECONDS` and another worker re-claims it. If the expired claim has no attempts left, it is marked `failed` rather than left stuck. Every write-back is fenced on `(locked_by, attempts)`, so a slow worker that lost its claim cannot overwrite the new owner's result. Nothing is dropped silently: every invoice ends in `needs_review` or `failed`, with an event explaining why.

**Posting and API calls.** Individual Xero calls retry 429 and 5xx with backoff, honouring `Retry-After`. A 401 forces one token refresh and a retry. If a post still fails, the approval stands and the invoice stays `approved` with `post_attempts`, `last_error` and a backoff time (`next_post_at`). The accounting sweeper, which runs next to the worker, retries it until `ACCOUNTING_MAX_POST_ATTEMPTS`; after that, or for a non-retryable error such as an invalid account code, it waits for a human to click "Post to Xero". The sweeper also posts approvals whose request died before posting.

**OAuth tokens** live encrypted (AES-256-GCM) in `accounting_connections`, not in memory, so every process and restart shares one token chain. They are refreshed five minutes *before* expiry. Xero rotates refresh tokens on every use, so the refresh runs under a row lock with a re-check: if two processes notice expiry together, the second sees the first's fresh token and doesn't refresh. A rejected refresh token (`invalid_grant`) deletes the connection so the UI asks to reconnect. A weekly keep-alive refresh stops idle connections hitting Xero's 60-day refresh-token expiry.

## Reconciliation

Posting moves an invoice to `submitted` once Xero has given us an InvoiceID. Reconciliation then re-reads the bill from Xero and compares it with the approved values. It compares total, subtotal and tax in integer cents; it also checks currency, invoice number, and that the bill is still live (`DRAFT`, `SUBMITTED`, `AUTHORISED` or `PAID`, not `VOIDED` or `DELETED`). A match sets `posted`; any difference sets `mismatch`, and the specific differences are stored in `reconcile_result` and shown in the UI. Tax is sent per line, allocated in cents, rather than letting Xero apply the account's default rate, so a correct post reconciles exactly and a wrong one is caught rather than hidden.

Reconciliation is read-only towards Xero and only overwrites our own result, so it is safe to re-run at any time:
- the "Re-run reconciliation" button;
- the sweeper, which picks up anything left in `submitted`;
- `npm run reconcile`, which re-checks every posted invoice and exits non-zero on any mismatch so it can gate a scheduled job.

A transient Xero error during reconciliation records `last_error` but never flips a status, so an outage can't produce false mismatches. If someone later edits or voids the bill in Xero, the next reconciliation moves the invoice to `mismatch`; once the bill is corrected, re-running it moves the invoice back to `posted`.
