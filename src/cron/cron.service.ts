import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { CryptoService } from '../crypto/crypto.service';
import { DatabaseService } from '../database/database.service';

interface SocialAccountTokenRow {
  id: string;
  tenant_id: string;
  encrypted_access_token: string;
  token_expires_at: string | null;
  platform: string;
  status: string;
  token_source: 'manual' | 'facebook_oauth' | null;
}

interface RefreshResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleTokenTtlCheck() {
    const supabase = this.databaseService.getClient();
    const lookaheadHours = this.resolveLookaheadHours();
    const thresholdTimestamp = Date.now() + lookaheadHours * 60 * 60 * 1000;

    this.logger.log(
      `Running token refresh scan for active Instagram accounts (lookahead=${lookaheadHours}h)`,
    );

    const { data: accounts, error } = await supabase
      .from('social_accounts')
      .select(
        'id, tenant_id, encrypted_access_token, token_expires_at, platform, status, token_source',
      )
      .eq('status', 'active')
      .eq('platform', 'instagram');

    if (error) {
      this.logger.error(`Failed to fetch social accounts: ${error.message}`);
      return;
    }

    const rows = (accounts ?? []) as SocialAccountTokenRow[];

    for (const account of rows) {
      await this.refreshIfExpiring(account, thresholdTimestamp);
    }

    await this.expireStaleOauthSessions();
  }

  private async refreshIfExpiring(
    account: SocialAccountTokenRow,
    thresholdTimestamp: number,
  ) {
    let decryptedAccessToken: string;
    try {
      decryptedAccessToken = this.cryptoService.decrypt(
        account.encrypted_access_token,
      );
    } catch (decryptError) {
      const reason =
        decryptError instanceof Error
          ? decryptError.message
          : 'Unknown decrypt error';
      this.logger.error(
        `Skipping account=${account.id}, token decrypt failed: ${reason}`,
      );
      await this.logAudit(account.tenant_id, 'token_refresh_failed', {
        social_account_id: account.id,
        error: `decrypt_failed:${reason}`,
      });
      return;
    }

    const expiresAt = this.resolveTokenExpiry(
      account.token_expires_at,
      decryptedAccessToken,
    );

    if (!expiresAt) {
      this.logger.warn(
        `Skipping account=${account.id}, no token expiry metadata was found`,
      );
      return;
    }

    if (expiresAt.getTime() > thresholdTimestamp) {
      return;
    }

    try {
      const refreshResult =
        account.token_source === 'facebook_oauth'
          ? await this.refreshFacebookOauthToken(decryptedAccessToken)
          : await this.refreshInstagramToken(decryptedAccessToken);

      const refreshedToken = refreshResult.access_token ?? decryptedAccessToken;
      const expiresInSeconds = Number(refreshResult.expires_in ?? 0);
      const refreshedExpiresAt =
        expiresInSeconds > 0
          ? new Date(Date.now() + expiresInSeconds * 1000)
          : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

      const encryptedToken = this.cryptoService.encrypt(refreshedToken);
      const supabase = this.databaseService.getClient();

      const { error: updateError } = await supabase
        .from('social_accounts')
        .update({
          encrypted_access_token: encryptedToken,
          token_expires_at: refreshedExpiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', account.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      this.logger.log(
        `Refreshed ${account.token_source ?? 'manual'} token for social_account=${account.id} (tenant=${account.tenant_id})`,
      );

      await this.logAudit(account.tenant_id, 'token_refreshed', {
        social_account_id: account.id,
        token_source: account.token_source ?? 'manual',
        old_expires_at: expiresAt.toISOString(),
        new_expires_at: refreshedExpiresAt.toISOString(),
      });
    } catch (refreshError) {
      const reason = axios.isAxiosError(refreshError)
        ? JSON.stringify(refreshError.response?.data ?? refreshError.message)
        : refreshError instanceof Error
          ? refreshError.message
          : 'Unknown refresh error';

      this.logger.error(
        `Token refresh failed for social_account=${account.id}: ${reason}`,
      );

      await this.logAudit(account.tenant_id, 'token_refresh_failed', {
        social_account_id: account.id,
        error: reason,
      });
    }
  }

  private resolveTokenExpiry(
    tokenExpiresAt: string | null,
    accessToken: string,
  ): Date | null {
    if (tokenExpiresAt) {
      const parsedDate = new Date(tokenExpiresAt);
      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return this.decodeJwtExpiry(accessToken);
  }

  private decodeJwtExpiry(accessToken: string): Date | null {
    const tokenParts = accessToken.split('.');
    if (tokenParts.length !== 3) {
      return null;
    }

    try {
      const encodedPayload = tokenParts[1]
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const paddedPayload = encodedPayload.padEnd(
        Math.ceil(encodedPayload.length / 4) * 4,
        '=',
      );

      const jsonPayload = Buffer.from(paddedPayload, 'base64').toString('utf8');
      const payload = JSON.parse(jsonPayload) as { exp?: number };

      if (!payload.exp || typeof payload.exp !== 'number') {
        return null;
      }

      return new Date(payload.exp * 1000);
    } catch {
      return null;
    }
  }

  private async refreshInstagramToken(
    accessToken: string,
  ): Promise<RefreshResponse> {
    const response = await axios.get<RefreshResponse>(
      'https://graph.instagram.com/refresh_access_token',
      {
        params: {
          grant_type: 'ig_refresh_token',
          access_token: accessToken,
        },
      },
    );

    return response.data;
  }

  private async refreshFacebookOauthToken(
    accessToken: string,
  ): Promise<RefreshResponse> {
    const appId = this.configService.get<string>('META_APP_ID');
    const appSecret = this.configService.get<string>('META_APP_SECRET');
    const graphVersion =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v20.0';

    if (!appId || !appSecret) {
      throw new Error(
        'META_APP_ID and META_APP_SECRET are required for facebook_oauth token refresh',
      );
    }

    const response = await axios.get<RefreshResponse>(
      `https://graph.facebook.com/${graphVersion}/oauth/access_token`,
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: accessToken,
        },
      },
    );

    return response.data;
  }

  private resolveLookaheadHours(): number {
    const configured = this.configService.get<string>(
      'TOKEN_REFRESH_LOOKAHEAD_HOURS',
    );
    const parsed = Number(configured ?? '168');

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 168;
    }

    return parsed;
  }

  private async logAudit(
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    const supabase = this.databaseService.getClient();
    const { error } = await supabase.from('audit_log').insert({
      tenant_id: tenantId,
      event_type: eventType,
      payload,
    });

    if (error) {
      this.logger.error(
        `Failed to write audit log (${eventType}) tenant=${tenantId}: ${error.message}`,
      );
    }
  }

  private async expireStaleOauthSessions() {
    const supabase = this.databaseService.getClient();
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('oauth_sessions')
      .update({
        status: 'expired',
        error_code: 'state_expired',
        updated_at: nowIso,
      })
      .in('status', ['started', 'pending_selection'])
      .lt('state_expires_at', nowIso);

    if (error) {
      this.logger.warn(`Failed to expire stale oauth sessions: ${error.message}`);
    }
  }
}
