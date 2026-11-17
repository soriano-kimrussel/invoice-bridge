/**
 * Standalone background process: `npm run worker` (dev) / `node dist/worker/main.js`.
 * Runs the extraction worker and, when Xero is configured, the accounting sweeper.
 * Run as many copies as you like; SKIP LOCKED and per-invoice row locks keep them from colliding.
 */
import 'dotenv/config'; // loads .env in development; no-op on Azure (settings come from App Service)
import { createXeroAccounting } from '../accounting/index.js';
import { AccountingSweeper } from '../accounting/sweeper.js';
import { loadBaseConfig, loadStorageConfig, loadWorkerConfig, loadXeroConfig, xeroConfigured } from '../config.js';
import { createDb } from '../db.js';
import { jsonLogger as log } from '../lib/log.js';
import { createStorage } from '../storage/index.js';
import { createExtractionWorker } from './factory.js';

async function main() {
  const base = loadBaseConfig();
  const db = createDb(base.DATABASE_URL);
  const worker = createExtractionWorker(db, createStorage(loadStorageConfig()), loadWorkerConfig(), {
    confidenceThreshold: base.CONFIDENCE_THRESHOLD,
    logger: log,
  });

  let sweeper: AccountingSweeper | undefined;
  if (xeroConfigured()) {
    const xero = loadXeroConfig();
    sweeper = new AccountingSweeper(createXeroAccounting(db, xero, log), xero.ACCOUNTING_SWEEP_INTERVAL_MS, log);
  } else {
    log.warn({}, 'Xero not configured: accounting sweeper disabled');
  }

  const shutdown = async () => {
    await Promise.all([worker.stop(), sweeper?.stop()]);
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  worker.start();
  sweeper?.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
