import 'dotenv/config';

/**
 * DB-backed tests run against a real, natively installed PostgreSQL (no
 * containers). They need TEST_DATABASE_URL pointing at a throwaway database
 * whose name contains "test", because every suite truncates its tables.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const hasTestDb = TEST_DATABASE_URL !== '';

export function assertSafeTestDb(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run tests against database "${dbName}": TEST_DATABASE_URL must name a database containing "test".`,
    );
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
  }
}
