import type { WorkerConfig } from '../config.js';
import type { Db } from '../db.js';
import { AzureInvoiceExtractor } from '../extraction/azure.js';
import type { FileStorage } from '../storage/types.js';
import { ExtractionWorker, type WorkerLogger } from './extractionWorker.js';

export function createExtractionWorker(
  db: Db,
  storage: FileStorage,
  config: WorkerConfig,
  extra: { confidenceThreshold: number; logger?: WorkerLogger },
): ExtractionWorker {
  const extractor = new AzureInvoiceExtractor({ endpoint: config.AZURE_DI_ENDPOINT, key: config.AZURE_DI_KEY });
  return new ExtractionWorker(db, storage, extractor, {
    batchSize: config.WORKER_BATCH_SIZE,
    leaseSeconds: config.WORKER_LEASE_SECONDS,
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    backoff: { baseMs: config.WORKER_BACKOFF_BASE_MS, maxMs: config.WORKER_BACKOFF_MAX_MS },
    confidenceThreshold: extra.confidenceThreshold,
    logger: extra.logger,
  });
}
