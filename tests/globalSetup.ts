import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { assertSafeTestDb, hasTestDb, TEST_DATABASE_URL } from './helpers/testEnv.js';

/** Creates the test database if needed and applies migrations to it. */
export default async function setup() {
  if (!hasTestDb) {
    const msg =
      'TEST_DATABASE_URL is not set: database-backed tests will be SKIPPED. See README "Running the tests".';
    if (process.env.REQUIRE_DB_TESTS === '1') throw new Error(msg);
    console.warn(`\n⚠  ${msg}\n`);
    return;
  }
  assertSafeTestDb(TEST_DATABASE_URL);

  const url = new URL(TEST_DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }

  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
