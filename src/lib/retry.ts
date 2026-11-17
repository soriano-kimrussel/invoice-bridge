import { backoffMs } from '../worker/backoff.js';

export type RetryOptions = {
  /** Total attempts including the first. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  isRetryable: (err: unknown) => boolean;
  /** Server-specified delay (e.g. Retry-After) overrides the computed backoff. */
  retryAfterMs?: (err: unknown) => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry a call with exponential backoff + jitter. Rethrows the last error. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.attempts || !opts.isRetryable(err)) throw err;
      const delay = Math.min(
        opts.maxMs,
        opts.retryAfterMs?.(err) ?? backoffMs(attempt, { baseMs: opts.baseMs, maxMs: opts.maxMs }, opts.random),
      );
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
