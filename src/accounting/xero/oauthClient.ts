import { XeroClient, type TokenSet } from 'xero-node';
import { InvalidGrantError, type OAuthClient, type OAuthTenant, type OAuthTokens } from '../tokenStore.js';

export type XeroOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
};

/** Xero OAuth2 Authorization Code flow via xero-node (openid-client underneath). */
export class XeroOAuthClient implements OAuthClient {
  constructor(private readonly cfg: XeroOAuthConfig) {}

  private client(state?: string): XeroClient {
    return new XeroClient({
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
      redirectUris: [this.cfg.redirectUri],
      scopes: this.cfg.scopes,
      state,
      httpTimeout: 10_000,
    });
  }

  async consentUrl(state: string): Promise<string> {
    const xero = this.client(state);
    await xero.initialize();
    return xero.buildConsentUrl();
  }

  /** Validates `state`, swaps the code for tokens, and lists the organisations the user granted. */
  async exchangeCode(callbackUrl: string, state: string): Promise<{ tokens: OAuthTokens; tenants: OAuthTenant[] }> {
    const xero = this.client(state);
    await xero.initialize();
    const tokenSet = await xero.apiCallback(callbackUrl);
    const tenants = (await xero.updateTenants(false)) as { tenantId: string; tenantName?: string; tenantType?: string }[];
    return {
      tokens: toTokens(tokenSet),
      tenants: tenants
        .filter((t) => !t.tenantType || t.tenantType === 'ORGANISATION')
        .map((t) => ({ tenantId: t.tenantId, tenantName: t.tenantName ?? null })),
    };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    try {
      const tokenSet = await this.client().refreshWithRefreshToken(this.cfg.clientId, this.cfg.clientSecret, refreshToken);
      return toTokens(tokenSet);
    } catch (err) {
      if (/invalid_grant/.test(safeStringify(err))) throw new InvalidGrantError();
      throw err;
    }
  }
}

export function toTokens(ts: TokenSet): OAuthTokens {
  if (!ts.access_token || !ts.refresh_token) {
    throw new Error('Xero did not return an access + refresh token (is offline_access in XERO_SCOPES?)');
  }
  const expiresAtSec = ts.expires_at ?? Math.floor(Date.now() / 1000) + (ts.expires_in ?? 1800);
  return {
    accessToken: ts.access_token,
    refreshToken: ts.refresh_token,
    expiresAt: new Date(expiresAtSec * 1000),
    scope: ts.scope ?? '',
  };
}

function safeStringify(err: unknown): string {
  try {
    const e = err as { message?: string; response?: { data?: unknown } };
    return `${e?.message ?? ''} ${JSON.stringify(e?.response?.data ?? err)}`;
  } catch {
    return String(err);
  }
}
