import { z } from 'zod';

/**
 * All configuration comes from environment variables. Nothing secret is ever
 * hardcoded. Sections are validated only when the feature that needs them is
 * used, so e.g. the test suite never needs Azure or Xero credentials.
 */

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Max upload size in bytes (default 20 MB, Azure DI's limit for the S0 tier is 500 MB, free tier 4 MB). */
  MAX_UPLOAD_BYTES: intFromEnv(20 * 1024 * 1024),
  /** Fields with confidence below this are flagged for the reviewer. */
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
});

const storageSchema = z.discriminatedUnion('STORAGE_DRIVER', [
  z.object({
    STORAGE_DRIVER: z.literal('local'),
    LOCAL_STORAGE_DIR: z.string().default('./data/uploads'),
  }),
  z.object({
    STORAGE_DRIVER: z.literal('azure'),
    AZURE_STORAGE_CONNECTION_STRING: z.string().min(1),
    AZURE_STORAGE_CONTAINER: z.string().min(3).default('invoices'),
  }),
]);

const workerSchema = z.object({
  AZURE_DI_ENDPOINT: z.url('AZURE_DI_ENDPOINT must be the resource endpoint URL'),
  AZURE_DI_KEY: z.string().min(1, 'AZURE_DI_KEY is required'),
  WORKER_MAX_ATTEMPTS: intFromEnv(5),
  WORKER_POLL_INTERVAL_MS: intFromEnv(2000),
  WORKER_LEASE_SECONDS: intFromEnv(300),
  WORKER_BATCH_SIZE: intFromEnv(4),
  WORKER_BACKOFF_BASE_MS: intFromEnv(5000),
  WORKER_BACKOFF_MAX_MS: intFromEnv(10 * 60 * 1000),
  /** Run the extraction worker inside the web process (handy on a single App Service instance). */
  RUN_WORKER_IN_PROCESS: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

/**
 * Xero granular scopes (required for Xero apps created from March 2026).
 * Older apps can set XERO_SCOPES to use `accounting.transactions` instead.
 */
export const DEFAULT_XERO_SCOPES =
  'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read';

const xeroSchema = z.object({
  XERO_CLIENT_ID: z.string().min(1, 'XERO_CLIENT_ID is required'),
  XERO_CLIENT_SECRET: z.string().min(1, 'XERO_CLIENT_SECRET is required'),
  XERO_REDIRECT_URI: z.url('XERO_REDIRECT_URI must be a URL, e.g. http://localhost:3000/auth/xero/callback'),
  XERO_SCOPES: z
    .string()
    .default(DEFAULT_XERO_SCOPES)
    .transform((s) => s.split(/[\s,]+/).filter(Boolean)),
  /** Pin a specific organisation; otherwise the first connected one (the Demo Company) is used. */
  XERO_TENANT_ID: z.string().optional(),
  /** Expense account code for bill lines in the Demo Company chart of accounts. */
  XERO_DEFAULT_ACCOUNT_CODE: z.string().min(1).default('400'),
  /** Optional TaxType for bill lines (e.g. INPUT for AU GST). Omit to use the account's default. */
  XERO_TAX_TYPE: z.string().optional(),
  /** 32 random bytes, base64. Encrypts OAuth tokens at rest. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((k) => Buffer.from(k, 'base64').length === 32, 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  ACCOUNTING_MAX_POST_ATTEMPTS: intFromEnv(5),
  ACCOUNTING_SWEEP_INTERVAL_MS: intFromEnv(30_000),
});

export type XeroConfig = z.infer<typeof xeroSchema>;

export function loadXeroConfig(env: Env = process.env): XeroConfig {
  return parse(xeroSchema, env, 'Xero');
}

/** True when enough Xero settings exist to offer the Connect button. */
export function xeroConfigured(env: Env = process.env): boolean {
  return xeroSchema.safeParse(env).success;
}

export type BaseConfig = z.infer<typeof baseSchema>;
export type StorageConfig = z.infer<typeof storageSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

type Env = Record<string, string | undefined>;

function parse<T extends z.ZodType>(schema: T, env: Env, section: string): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${section} configuration:\n${issues}`);
  }
  return result.data;
}

export function loadBaseConfig(env: Env = process.env): BaseConfig {
  return parse(baseSchema, env, 'base');
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  return parse(workerSchema, env, 'worker');
}

/** Only the "should the web process run the worker?" flag, without requiring Azure credentials. */
export function runWorkerInProcess(env: Env = process.env): boolean {
  return ['true', '1'].includes((env.RUN_WORKER_IN_PROCESS ?? '').toLowerCase());
}

export function loadStorageConfig(env: Env = process.env): StorageConfig {
  return parse(storageSchema, { STORAGE_DRIVER: 'local', ...env }, 'storage');
}
