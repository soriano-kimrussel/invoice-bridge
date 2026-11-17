import 'dotenv/config'; // loads .env in development; no-op on Azure (settings come from App Service)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createXeroAccounting, type AccountingModule } from './accounting/index.js';
import { AccountingSweeper } from './accounting/sweeper.js';
import { buildApp } from './app.js';
import {
  loadBaseConfig,
  loadStorageConfig,
  loadWorkerConfig,
  loadXeroConfig,
  runWorkerInProcess,
  xeroConfigured,
} from './config.js';
import { createDb } from './db.js';
import { jsonLogger } from './lib/log.js';
import { createStorage } from './storage/index.js';
import type { ExtractionWorker } from './worker/extractionWorker.js';
import { createExtractionWorker } from './worker/factory.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadBaseConfig();
  const db = createDb(config.DATABASE_URL);
  const storage = createStorage(loadStorageConfig());
  const inProcess = runWorkerInProcess();
  const workerConfig = inProcess ? loadWorkerConfig() : undefined;
  const xeroConfig = xeroConfigured() ? loadXeroConfig() : undefined;

  const accounting: AccountingModule | undefined = xeroConfig
    ? createXeroAccounting(db, xeroConfig, jsonLogger)
    : undefined;
  const app = await buildApp({
    db,
    storage,
    confidenceThreshold: config.CONFIDENCE_THRESHOLD,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS) || undefined,
    // src/ (tsx) and dist/ (built) are both one level below the project root.
    webRoot: path.resolve(here, '..', 'web', 'dist'),
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    accounting,
  });

  let worker: ExtractionWorker | undefined;
  let sweeper: AccountingSweeper | undefined;
  if (workerConfig) {
    worker = createExtractionWorker(db, storage, workerConfig, {
      confidenceThreshold: config.CONFIDENCE_THRESHOLD,
      logger: app.log,
    });
    if (accounting && xeroConfig) {
      sweeper = new AccountingSweeper(accounting, xeroConfig.ACCOUNTING_SWEEP_INTERVAL_MS, app.log);
    }
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await Promise.all([worker?.stop(), sweeper?.stop()]);
    await app.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    `storage: ${storage.driver}; xero: ${accounting ? 'configured' : 'not configured'}; in-process worker: ${worker ? 'on' : 'off'}`,
  );
  worker?.start();
  sweeper?.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
