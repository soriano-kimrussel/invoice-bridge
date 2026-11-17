# invoice-bridge

An AI invoice-to-accounting pipeline, modelled on a real accounts-payable automation app.

A supplier invoice (PDF or image) is uploaded, **Azure AI Document Intelligence** extracts the fields, a human checks them in a **review queue** with low-confidence fields highlighted, and on approval the invoice is posted to **Xero** as a draft accounts-payable bill (`Invoice` with `Type = ACCPAY`) over OAuth2. Posting is idempotent and every bill is **reconciled** against Xero, so re-posting never creates a duplicate and drift is surfaced.

- **Backend:** Node.js + TypeScript, Fastify 5, PostgreSQL via Prisma 7
- **Frontend:** React 19 + Vite, built and served by the backend as static files
- **Document AI:** Azure AI Document Intelligence `prebuilt-invoice` (`@azure-rest/ai-document-intelligence`)
- **Accounting:** Xero via `xero-node`, OAuth2 Authorization Code flow, behind an `AccountingProvider` interface (MYOB-ready)
- **Queue:** Postgres, `SELECT … FOR UPDATE SKIP LOCKED`, retries with backoff, max-attempts cap
- **Deploy:** Azure App Service (Node runtime, no containers), GitHub Actions, Bicep

No Docker, WSL, VMs or containers are used anywhere: not for development, tests, CI or deployment.

---

## Contents

1. [Architecture](#architecture)
2. [Install Node.js and PostgreSQL on Windows](#install-nodejs-and-postgresql-on-windows)
3. [Get an Azure Document Intelligence resource](#get-an-azure-document-intelligence-resource)
4. [Get a Xero developer app and the Demo Company](#get-a-xero-developer-app-and-the-demo-company)
5. [Configure environment variables](#configure-environment-variables)
6. [Run it locally](#run-it-locally)
7. [Running the tests](#running-the-tests)
8. [Deploy to Azure App Service](#deploy-to-azure-app-service)
9. [Project layout](#project-layout)
10. [API](#api)
11. [Limitations](#limitations)

---

## Architecture

```
            ┌───────────── React review UI (web/) ─────────────┐
            │ upload · queue tabs · file beside fields · edit   │
            └───────────────┬──────────────────────────────────┘
                            │ HTTP (Fastify, also serves web/dist)
 ┌──────────────────────────▼───────────────────────────────────────────────┐
 │ 1 Upload      sha256 → UNIQUE content_hash; file → local disk / Blob     │
 │               row: status=pending                                         │
 │ 2 Worker      UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) → processing│
 │               Azure DI prebuilt-invoice → zod → extracted + confidence    │
 │               ok → needs_review · transient → pending (+backoff)          │
 │               permanent / attempts exhausted → failed                     │
 │ 3 Review      human edits; arithmetic checked in integer cents → approved │
 │ 4 Post        row lock · reuse external_id · recover orphan · Xero ACCPAY │
 │               draft (Idempotency-Key = invoice id) → submitted            │
 │ 5 Reconcile   re-read bill; total/status/currency/number → posted|mismatch│
 └──────────────────────────────────────────────────────────────────────────┘
         PostgreSQL: invoices · invoice_events (audit) · accounting_connections (encrypted tokens)
```

**Status lifecycle:** `pending → processing → needs_review → approved → submitted → posted`. Side exits are `rejected` (by the reviewer), `failed` (extraction gave up) and `mismatch` (Xero disagrees with us). Every transition writes an `invoice_events` row.

**Layers and their boundaries** (`src/domain/invoice.ts`):

| Layer | Interface | Output |
|---|---|---|
| Extraction | `InvoiceExtractor` (`src/extraction/`) | `ExtractedInvoice`: each field `{ value, confidence }` |
| Review | `InvoiceService` (`src/invoices/`) | `ReviewedInvoice`: validated, totals add up |
| Accounting | `AccountingProvider` (`src/accounting/`) | `ExternalBill` + reconciliation result |

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for how idempotency, retries and reconciliation work.

---

## Install Node.js and PostgreSQL on Windows

Everything runs natively on Windows.

**Node.js 22 LTS or newer**

```powershell
winget install OpenJS.NodeJS.LTS
node -v   # v22+ (v24 works too)
```

Or use the installer from <https://nodejs.org/>.

**PostgreSQL 16+**

```powershell
winget install PostgreSQL.PostgreSQL.17
```

Or use the EDB installer from <https://www.postgresql.org/download/windows/>. Keep the default port 5432 and remember the `postgres` superuser password you choose. The installer registers a Windows service (e.g. `postgresql-x64-17`) that starts automatically.

Create a role and database for the app (adjust the version folder to yours):

```powershell
$psql = "C:\Program Files\PostgreSQL\17\bin\psql.exe"
& $psql -U postgres -c "CREATE ROLE invoice_bridge LOGIN PASSWORD 'change-me' CREATEDB;"
& $psql -U postgres -c "CREATE DATABASE invoice_bridge OWNER invoice_bridge;"
```

`CREATEDB` lets the test suite create its own `invoice_bridge_test` database. Without it, create that database yourself the same way.

---

## Get an Azure Document Intelligence resource

1. In the [Azure portal](https://portal.azure.com) choose **Create a resource → Document Intelligence** (formerly Form Recognizer).
2. Pick a resource group and region. Pricing tier **F0** is free (500 pages/month, first 2 pages per document); **S0** is pay-as-you-go.
3. After deployment, open **Keys and Endpoint** and copy **Endpoint** and **Key 1** into `AZURE_DI_ENDPOINT` and `AZURE_DI_KEY`.

Or use the Azure CLI:

```powershell
az group create -n rg-invoice-bridge-dev -l australiaeast
az cognitiveservices account create -n <unique-name> -g rg-invoice-bridge-dev -l australiaeast `
  --kind FormRecognizer --sku F0 --custom-domain <unique-name> --yes
az cognitiveservices account show -n <unique-name> -g rg-invoice-bridge-dev --query properties.endpoint
az cognitiveservices account keys list -n <unique-name> -g rg-invoice-bridge-dev --query key1
```

Need a test document? Microsoft publishes sample invoices in the [Document Intelligence samples](https://github.com/Azure-Samples/cognitive-services-REST-api-samples/tree/master/curl/form-recognizer), e.g. `sample-invoice.pdf`.

---

## Get a Xero developer app and the Demo Company

1. Sign up (free) at <https://developer.xero.com/> and open **My Apps → New app**.
2. Choose **Web app**. Set the **Redirect URI** to exactly `http://localhost:3000/auth/xero/callback`; add your Azure URL here later.
3. Under **Configuration**, generate a **client secret**. Copy the client id and secret into `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`.
4. Open the **Demo Company**: in Xero, click the organisation name → **My Xero → Try the Demo Company** (it resets every 28 days). When you click **Connect Xero** in invoice-bridge, grant access to **Demo Company** only.
5. **Scopes:** the default `XERO_SCOPES` uses Xero's granular scopes (`accounting.invoices`, `accounting.contacts`, `accounting.settings.read`), required for apps created from March 2026. If your app predates that and the consent screen rejects them, set `accounting.transactions` in place of `accounting.invoices`.
6. **Account code:** bills post to the expense account in `XERO_DEFAULT_ACCOUNT_CODE` (default `400`). Check the Demo Company's **Chart of accounts** and pick an expense account. Optionally set `XERO_TAX_TYPE` (AU demo: `INPUT`, UK demo: `INPUT2`).

---

## Configure environment variables

```powershell
Copy-Item .env.example .env
notepad .env
```

All secrets come from environment variables. Nothing secret is in the code. The minimum to run end to end:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgresql://invoice_bridge:change-me@localhost:5432/invoice_bridge` |
| `TEST_DATABASE_URL` | separate DB whose name contains `test`, used by `npm test` |
| `STORAGE_DRIVER` | `local` (dev) or `azure` |
| `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY` | Document Intelligence |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` | Xero app |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64, used to encrypt stored OAuth tokens |

Generate the encryption key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`.env.example` documents every other knob (confidence threshold, retry/backoff, lease time, sweep interval…). The app starts without Azure or Xero settings: extraction then needs the worker config, and the UI shows "Xero not configured".

---

## Run it locally

```powershell
npm install
npm run db:generate      # generate the Prisma client
npm run db:deploy        # apply migrations to DATABASE_URL
npm run build:web        # build the React UI (served by the API at http://localhost:3000)
```

Then start two processes, each in its own terminal:

```powershell
npm run dev              # API + UI on http://localhost:3000
npm run worker           # extraction worker + Xero sweeper
```

Or set `RUN_WORKER_IN_PROCESS=true` in `.env` and run only `npm run dev`.

**Walkthrough**

1. Open <http://localhost:3000>, type a reviewer name (top right) and click **Connect Xero**. Log in, pick the **Demo Company**, and you land back with a "Connected" banner.
2. Drag an invoice PDF onto the upload area. It appears under **Extracting**; within a few seconds the worker moves it to **Needs review**.
3. Open it. The original is on the left and the extracted fields are on the right. Amber fields were read with confidence below `CONFIDENCE_THRESHOLD`, and each shows its percentage. Fix anything wrong. The totals checks run as you type and offer one-click fixes.
4. Click **Approve & post to Xero**. The invoice goes `approved → submitted → posted`: a draft bill is created in Xero, then re-read and reconciled. The panel shows the Xero InvoiceID.
5. Click **Approve** again, or **Re-run reconciliation**: no second bill appears. Edit the bill's total in Xero and re-run reconciliation to see a **Mismatch** with the exact difference.

For hot-reloading UI development, run `npm run dev:web` as well and use <http://localhost:5173>; Vite proxies `/api` and `/auth` to port 3000. OAuth still uses the `:3000` redirect URI.

`npm run reconcile` re-checks every posted invoice against Xero and exits with code 1 if anything mismatches.

---

## Running the tests

```powershell
npm test
```

- **Vitest**, no containers. Azure Document Intelligence and Xero are **mocked**; the suite never calls a live service.
- Suites that exercise SQL (worker locking with `SKIP LOCKED`, the API, idempotent posting, token refresh, reconciliation) run against your native PostgreSQL using `TEST_DATABASE_URL`. The test setup creates that database if it's missing, applies migrations, and truncates tables between tests. It refuses to run against a database whose name doesn't contain `test`.
- If `TEST_DATABASE_URL` is unset, those suites are **skipped with a warning**. CI sets `REQUIRE_DB_TESTS=1` so they fail instead.

What's covered:

| Area | File |
|---|---|
| Worker locking: exactly-once claims across 6 concurrent workers, `SKIP LOCKED` not blocking, lease expiry, fencing, retries/backoff, max attempts | `tests/worker.test.ts` |
| Azure mapping and error classification (SDK mocked) | `tests/extraction.test.ts` |
| Idempotent posting: double-click, concurrent posts, orphan recovery, duplicates, sweeper retries | `tests/accounting.db.test.ts` |
| Token refresh: before expiry, single refresh under concurrency, `invalid_grant`, keep-alive, encryption at rest | `tests/accounting.db.test.ts` |
| Reconciliation: match, mismatch, voided/deleted, re-run safety, transient errors | `tests/accounting.db.test.ts`, `tests/accounting.unit.test.ts` |
| Xero mapping, retries/429/401, OAuth state (CSRF) | `tests/accounting.unit.test.ts`, `tests/accounting.db.test.ts` |
| Upload idempotency, review API, approvals | `tests/api.test.ts` |

Before committing, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`.

---

## Deploy to Azure App Service

The app runs on **App Service with the Node 22 runtime**: no image build, no container registry. CI builds a zip containing `dist/`, `web/dist/`, `prisma/` and production `node_modules`, and deploys it with `azure/webapps-deploy`. On start, App Service runs `npm run start:azure`, which applies pending migrations (`prisma migrate deploy`) and starts the server. The extraction worker and the Xero sweeper run in the same process (`RUN_WORKER_IN_PROCESS=true`, with Always On enabled).

### What `infra/main.bicep` provisions

- App Service plan (Linux, B1) and web app (`NODE|22-lts`, HTTPS only, Always On, health check `/healthz`, system-assigned identity)
- Azure Database for PostgreSQL flexible server (Burstable B1ms, PG 16) and the `invoice_bridge` database
- Storage account with a private `invoices` blob container
- Document Intelligence account (`FormRecognizer`, S0 by default)
- Key Vault (RBAC) holding the database URL, storage connection string, Document Intelligence key, Xero client id/secret and token encryption key. App settings reference them as `@Microsoft.KeyVault(...)`, and the web app's identity gets **Key Vault Secrets User**.

### Steps

**1. Create the resource group and a GitHub OIDC identity** (one time; Azure CLI, PowerShell):

```powershell
az login
$sub  = az account show --query id -o tsv
$rg   = "rg-invoice-bridge"
az group create -n $rg -l australiaeast

$appId = az ad app create --display-name "invoice-bridge-github" --query appId -o tsv
az ad sp create --id $appId
# Replace OWNER/REPO with your GitHub repository
az ad app federated-credential create --id $appId --parameters (@{
  name = "gh-production"; issuer = "https://token.actions.githubusercontent.com"
  subject = "repo:OWNER/REPO:environment:production"; audiences = @("api://AzureADTokenExchange")
} | ConvertTo-Json -Compress)

# Contributor to deploy resources; RBAC Administrator so Bicep can grant the app access to Key Vault
az role assignment create --assignee $appId --role "Contributor" --scope "/subscriptions/$sub/resourceGroups/$rg"
az role assignment create --assignee $appId --role "Role Based Access Control Administrator" --scope "/subscriptions/$sub/resourceGroups/$rg"
az account show --query tenantId -o tsv   # → AZURE_TENANT_ID
```

**2. Configure the GitHub repository.** Under Settings → Environments, create **`production`** and add:

- **Secrets:** `AZURE_CLIENT_ID` (= `$appId`), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (= `$sub`), `POSTGRES_ADMIN_PASSWORD`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`
- **Variables:** `AZURE_NAME_PREFIX` (e.g. `ibdemo`, 3–11 lowercase chars)

**3. Provision the infrastructure.** Run Actions → **infra** → *Run workflow* with resource group `rg-invoice-bridge`. The run log prints the outputs (`webAppName`, `url`, `xeroRedirectUri`).

To do this from your machine instead:

```powershell
az deployment group create -g rg-invoice-bridge -f infra/main.bicep -p infra/main.parameters.json `
  -p namePrefix=ibdemo postgresAdminPassword=<strong-password> xeroClientId=<id> xeroClientSecret=<secret> tokenEncryptionKey=<base64-32-bytes>
```

**4. Point CI at the web app.** Add the repository variable `AZURE_WEBAPP_NAME` = the `webAppName` output. Until this variable exists, the **ci** workflow skips its `deploy` job, so pushes only build and test.

**5. Register the production redirect URI in Xero.** In your Xero app add `https://<webAppName>.azurewebsites.net/auth/xero/callback` (the `xeroRedirectUri` output).

**6. Deploy.** Push to `main`. The **ci** workflow installs, lints, typechecks, tests against the runner's natively installed PostgreSQL, builds the server and React frontend, packages the zip, deploys it with `azure/webapps-deploy`, and polls `/healthz`.

To deploy manually instead, build the same `app.zip` (see the *Assemble deployment package* step in `.github/workflows/ci.yml`), then run:

```powershell
az webapp deploy -g rg-invoice-bridge -n <webAppName> --src-path app.zip --type zip
```

**7. First run.** Open `https://<webAppName>.azurewebsites.net`, click **Connect Xero**, choose the Demo Company, and upload an invoice. If Key Vault references show as unresolved right after the first provisioning (the role assignment takes a minute to propagate), restart the web app: `az webapp restart -g rg-invoice-bridge -n <webAppName>`.

**Scaling out:** with more than one instance, every instance runs the worker in-process. That is safe, because `SKIP LOCKED` and the per-invoice posting lock prevent double work. To separate concerns, set `RUN_WORKER_IN_PROCESS=false` on the web app and run `node dist/worker/main.js` in a second App Service app or WebJob.

---

## Project layout

```
src/
  domain/          shared types + zod schemas (also imported by the UI): invoice.ts, api.ts
  invoices/        upload, review queue service + routes, file-type sniffing
  storage/         FileStorage: local disk, Azure Blob, in-memory (tests)
  extraction/      InvoiceExtractor, Azure DI client, pure result mapper
  worker/          Postgres queue worker (SKIP LOCKED), backoff, standalone entry
  accounting/      AccountingProvider, PostingService (post + reconcile + sweep), TokenStore,
    xero/          OAuth client, ACCPAY mapping, provider on xero-node
  app.ts server.ts Fastify app factory and entry point
prisma/            schema.prisma + migrations (timestamptz everywhere)
web/               React + Vite review UI
tests/             Vitest suites + fakes for Azure/Xero
infra/             Bicep for Azure
.github/workflows/ CI/CD (no containers)
```

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/invoices` | multipart `file`; 201 new, 200 `duplicate: true` |
| `GET` | `/api/invoices?status=needs_review,failed&limit=&cursor=` | queue, oldest first |
| `GET` | `/api/invoices/counts` | per-status counts |
| `GET` | `/api/invoices/:id` | detail, form values, low-confidence fields, events |
| `GET` | `/api/invoices/:id/file` | original document |
| `PUT` | `/api/invoices/:id/review` | save draft edits |
| `POST` | `/api/invoices/:id/approve` | approve (+ post + reconcile if Xero is connected) |
| `POST` | `/api/invoices/:id/reject` · `/retry` · `/post` · `/reconcile` | |
| `GET` | `/api/accounting/status` · `POST /api/accounting/disconnect` | |
| `GET` | `/auth/xero/connect` · `/auth/xero/callback` | OAuth2 Authorization Code flow |
| `GET` | `/healthz` | DB check |

## Limitations

- **No user authentication.** The reviewer name is a header for the audit trail. Before real use, put the app behind App Service Authentication (Entra ID) and derive the reviewer from the signed-in user.
- **One accounting organisation** per deployment (single-tenant connection).
- **Contacts** are matched by name; Xero creates the supplier contact if it doesn't exist.
- **Bills post as `DRAFT`**, so someone with Xero access still authorises them for payment.
