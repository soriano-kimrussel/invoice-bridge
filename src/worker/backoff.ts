export type BackoffOptions = { baseMs: number; maxMs: number };

/**
 * Exponential backoff with "equal jitter": the delay after attempt n is
 * between 50% and 100% of min(max, base · 2^(n-1)). Jitter stops a burst of
 * invoices that failed together (e.g. an Azure 429) retrying in lockstep.
 */
export function backoffMs(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + (exp / 2) * random());
}
