import type { Db } from '../db.js';
import type { TokenCipher } from './crypto.js';
import { AccountingError, NotConnectedError } from './types.js';

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
};

export type OAuthTenant = { tenantId: string; tenantName: string | null };

/** The OAuth2 Authorization Code flow, as the token store needs it. Xero implements it; tests fake it. */
export interface OAuthClient {
  consentUrl(state: string): Promise<string>;
  exchangeCode(callbackUrl: string, state: string): Promise<{ tokens: OAuthTokens; tenants: OAuthTenant[] }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

/** Thrown by OAuthClient.refresh when the refresh token is dead (revoked, expired after 60 days, reused). */
export class InvalidGrantError extends Error {
  constructor(message = 'refresh token rejected (invalid_grant)') {
    super(message);
    this.name = 'InvalidGrantError';
  }
}

export type AccessGrant = { accessToken: string; tenantId: string };

export type TokenStoreOptions = {
  provider: string;
  /** Refresh when the access token has less than this left (Xero access tokens live 30 minutes). */
  refreshSkewMs?: number;
  now?: () => Date;
};

/**
 * Persists OAuth tokens in Postgres (encrypted) and hands out valid access
 * tokens, refreshing *before* expiry.
 *
 * Xero rotates refresh tokens: each refresh returns a new one and the old one
 * stops working. If two processes refreshed at once, one would store a token
 * the other just invalidated. So refresh happens under a row lock
 * (SELECT … FOR UPDATE) with a re-check: whoever gets the lock second sees the
 * fresh token and uses it instead of refreshing again.
 */
export class TokenStore {
  private readonly provider: string;
  private readonly skewMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly oauth: OAuthClient,
    private readonly cipher: TokenCipher,
    opts: TokenStoreOptions,
  ) {
    this.provider = opts.provider;
    this.skewMs = opts.refreshSkewMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Store the result of a completed authorisation (callback), replacing any previous connection. */
  async saveConnection(tokens: OAuthTokens, tenant: OAuthTenant): Promise<void> {
    const data = {
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
      scope: tokens.scope,
      accessTokenExpiresAt: tokens.expiresAt,
      lastRefreshedAt: null,
    };
    await this.db.accountingConnection.upsert({
      where: { provider: this.provider },
      create: { provider: this.provider, ...data },
      update: data,
    });
  }

  async disconnect(): Promise<void> {
    await this.db.accountingConnection.deleteMany({ where: { provider: this.provider } });
  }

  async status() {
    const c = await this.db.accountingConnection.findUnique({ where: { provider: this.provider } });
    return c
      ? { connected: true, tenantId: c.tenantId, tenantName: c.tenantName, accessTokenExpiresAt: c.accessTokenExpiresAt }
      : { connected: false, tenantId: null, tenantName: null, accessTokenExpiresAt: null };
  }

  /** A non-expired access token, refreshing first if it is about to expire. */
  async getAccessToken(): Promise<AccessGrant> {
    const c = await this.db.accountingConnection.findUnique({ where: { provider: this.provider } });
    if (!c) throw new NotConnectedError();
    if (!this.expiringSoon(c.accessTokenExpiresAt)) {
      return { accessToken: this.cipher.decrypt(c.accessTokenEnc), tenantId: c.tenantId };
    }
    return this.refresh(false);
  }

  /**
   * Refresh under a row lock. With `force` (e.g. after a 401) the token is
   * refreshed even if it does not look expired, unless another process
   * refreshed it in the meantime.
   */
  async refresh(force: boolean, seenAccessTokenEnc?: string): Promise<AccessGrant> {
    let revoked = false;
    try {
      return await this.db.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM accounting_connections WHERE provider = ${this.provider} FOR UPDATE`;
          if (locked.length === 0) throw new NotConnectedError();
          const c = await tx.accountingConnection.findUniqueOrThrow({ where: { provider: this.provider } });

          const someoneElseRefreshed = seenAccessTokenEnc !== undefined && c.accessTokenEnc !== seenAccessTokenEnc;
          if (!this.expiringSoon(c.accessTokenExpiresAt) && (!force || someoneElseRefreshed)) {
            return { accessToken: this.cipher.decrypt(c.accessTokenEnc), tenantId: c.tenantId };
          }

          let fresh: OAuthTokens;
          try {
            fresh = await this.oauth.refresh(this.cipher.decrypt(c.refreshTokenEnc));
          } catch (err) {
            if (err instanceof InvalidGrantError) {
              revoked = true;
              throw new NotConnectedError('Xero authorisation has expired or was revoked; reconnect Xero');
            }
            throw new AccountingError(`token refresh failed: ${(err as Error).message}`, true);
          }

          await tx.accountingConnection.update({
            where: { provider: this.provider },
            data: {
              accessTokenEnc: this.cipher.encrypt(fresh.accessToken),
              refreshTokenEnc: this.cipher.encrypt(fresh.refreshToken),
              accessTokenExpiresAt: fresh.expiresAt,
              scope: fresh.scope || c.scope,
              lastRefreshedAt: this.now(),
            },
          });
          return { accessToken: fresh.accessToken, tenantId: c.tenantId };
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
    } finally {
      // A dead refresh token can never recover: drop the connection so the UI asks to reconnect.
      if (revoked) await this.disconnect();
    }
  }

  /**
   * Keep the refresh-token chain alive. Xero refresh tokens expire after 60
   * days unused, so a quiet system refreshes proactively every `maxAgeMs`.
   */
  async keepAlive(maxAgeMs: number): Promise<boolean> {
    const c = await this.db.accountingConnection.findUnique({ where: { provider: this.provider } });
    if (!c) return false;
    const last = (c.lastRefreshedAt ?? c.updatedAt).getTime();
    if (this.now().getTime() - last < maxAgeMs) return false;
    await this.refresh(true, c.accessTokenEnc);
    return true;
  }

  /** Force a refresh after the provider rejected the current access token (401). */
  async refreshAfterUnauthorized(): Promise<AccessGrant> {
    const c = await this.db.accountingConnection.findUnique({ where: { provider: this.provider } });
    if (!c) throw new NotConnectedError();
    return this.refresh(true, c.accessTokenEnc);
  }

  private expiringSoon(expiresAt: Date): boolean {
    return expiresAt.getTime() - this.now().getTime() <= this.skewMs;
  }
}
