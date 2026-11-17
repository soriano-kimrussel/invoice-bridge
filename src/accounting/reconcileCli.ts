/**
 * Re-run reconciliation for every posted invoice: `npm run reconcile`.
 * Safe to run any time (read-only against Xero; only rewrites our result).
 * Exits non-zero if anything mismatches, so it can gate a scheduled job.
 */
import 'dotenv/config'; // loads .env in development; no-op on Azure (settings come from App Service)
import { loadBaseConfig, loadXeroConfig } from '../config.js';
import { createDb } from '../db.js';
import { createXeroAccounting } from './index.js';

async function main() {
  const db = createDb(loadBaseConfig().DATABASE_URL);
  try {
    const acc = createXeroAccounting(db, loadXeroConfig());
    const totals = await acc.posting.reconcileAll();
    console.log(JSON.stringify({ reconciled: totals }));
    process.exitCode = totals.mismatch > 0 || totals.errors > 0 ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
