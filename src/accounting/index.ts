import type { XeroConfig } from '../config.js';
import type { Db } from '../db.js';
import type { WorkerLogger } from '../worker/extractionWorker.js';
import { TokenCipher } from './crypto.js';
import { PostingService } from './postingService.js';
import { TokenStore, type OAuthClient } from './tokenStore.js';
import type { AccountingProvider } from './types.js';
import { XeroOAuthClient } from './xero/oauthClient.js';
import { XeroAccountingProvider, XeroNodeInvoicesApi } from './xero/xeroProvider.js';

/** Everything the HTTP layer and the sweeper need from the accounting side. */
export type AccountingModule = {
  providerName: string;
  oauth: OAuthClient;
  tokens: TokenStore;
  provider: AccountingProvider;
  posting: PostingService;
  /** Tenant to pin (XERO_TENANT_ID), else the first one granted. */
  preferredTenantId?: string;
  redirectUri: string;
};

export function createXeroAccounting(db: Db, cfg: XeroConfig, logger?: WorkerLogger): AccountingModule {
  const oauth = new XeroOAuthClient({
    clientId: cfg.XERO_CLIENT_ID,
    clientSecret: cfg.XERO_CLIENT_SECRET,
    redirectUri: cfg.XERO_REDIRECT_URI,
    scopes: cfg.XERO_SCOPES,
  });
  const tokens = new TokenStore(db, oauth, new TokenCipher(cfg.TOKEN_ENCRYPTION_KEY), { provider: 'xero' });
  const provider = new XeroAccountingProvider(tokens, new XeroNodeInvoicesApi(), {
    accountCode: cfg.XERO_DEFAULT_ACCOUNT_CODE,
    taxType: cfg.XERO_TAX_TYPE,
  });
  const posting = new PostingService(db, provider, { maxPostAttempts: cfg.ACCOUNTING_MAX_POST_ATTEMPTS, logger });
  return {
    providerName: 'xero',
    oauth,
    tokens,
    provider,
    posting,
    preferredTenantId: cfg.XERO_TENANT_ID,
    redirectUri: cfg.XERO_REDIRECT_URI,
  };
}

export { PostingService, TokenStore };
