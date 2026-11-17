import { createDb, type Db } from '../../src/db.js';
import { assertSafeTestDb, TEST_DATABASE_URL } from './testEnv.js';

export { hasTestDb } from './testEnv.js';

export function createTestDb(): Db {
  assertSafeTestDb(TEST_DATABASE_URL);
  return createDb(TEST_DATABASE_URL);
}

export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE invoice_events, invoices, accounting_connections RESTART IDENTITY CASCADE');
}
