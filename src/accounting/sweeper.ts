import type { WorkerLogger } from '../worker/extractionWorker.js';
import type { AccountingModule } from './index.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Safety net that runs next to the extraction worker: retries failed posts
 * with backoff, reconciles invoices stuck in 'submitted', and keeps the OAuth
 * refresh token alive. Several copies may run; posting is serialised per
 * invoice by a row lock, so overlap is harmless.
 */
export class AccountingSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly acc: AccountingModule,
    private readonly intervalMs: number,
    private readonly log: WorkerLogger,
  ) {}

  async tick(): Promise<void> {
    const status = await this.acc.tokens.status();
    if (!status.connected) return;
    try {
      if (await this.acc.tokens.keepAlive(7 * DAY)) this.log.info({}, 'refreshed Xero token (keep-alive)');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'Xero keep-alive refresh failed');
    }
    const r = await this.acc.posting.sweep();
    if (r.posted || r.reconciled || r.errors) this.log.info(r, 'accounting sweep');
  }

  start(): void {
    const loop = () => {
      this.running = this.tick()
        .catch((err) => this.log.error({ err: (err as Error).message }, 'accounting sweep failed'))
        .finally(() => {
          if (this.timer !== undefined) this.timer = setTimeout(loop, this.intervalMs);
        });
    };
    this.timer = setTimeout(loop, 1000);
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
