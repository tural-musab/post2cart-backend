import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../crypto/crypto.service';

interface SocialAccountJoin {
  id: string;
  platform: string;
  platform_account_id: string;
  platform_username: string | null;
  encrypted_access_token: string;
  token_expires_at: string | null;
  status: string;
}

interface SyncStateRow {
  id: string;
  tenant_id: string;
  social_account_id: string;
  last_cursor_id: string | null;
  last_synced_at: string | null;
  social_accounts: SocialAccountJoin[] | SocialAccountJoin | null;
}

export interface ActiveSyncState {
  sync_state_id: string;
  tenant_id: string;
  social_account_id: string;
  platform: string;
  platform_account_id: string;
  platform_username: string | null;
  last_cursor_id: string | null;
  last_synced_at: string | null;
  token_expires_at: string | null;
  decrypted_access_token: string;
}

@Injectable()
export class SyncStateService {
  private readonly logger = new Logger(SyncStateService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
  ) {}

  async getActiveSyncStates(): Promise<ActiveSyncState[]> {
    const supabase = this.databaseService.getClient();

    const { data, error } = await supabase
      .from('sync_state')
      .select(
        `
          id,
          tenant_id,
          social_account_id,
          last_cursor_id,
          last_synced_at,
          social_accounts!inner(
            id,
            platform,
            platform_account_id,
            platform_username,
            encrypted_access_token,
            token_expires_at,
            status
          )
        `,
      )
      .eq('is_active', true)
      .eq('social_accounts.status', 'active');

    if (error) {
      this.logger.error(`Failed to fetch active sync states: ${error.message}`);
      throw new InternalServerErrorException('Failed to fetch active sync states');
    }

    const now = Date.now();
    const rows = (data ?? []) as SyncStateRow[];
    const activeStates: ActiveSyncState[] = [];

    for (const row of rows) {
      const account = Array.isArray(row.social_accounts)
        ? row.social_accounts[0]
        : row.social_accounts;
      if (!account) {
        continue;
      }

      if (account.token_expires_at) {
        const expiry = new Date(account.token_expires_at).getTime();
        if (!Number.isNaN(expiry) && expiry <= now) {
          this.logger.warn(
            `Skipping expired token for sync_state=${row.id}, social_account=${account.id}`,
          );
          continue;
        }
      }

      let decryptedAccessToken: string;
      try {
        decryptedAccessToken = this.cryptoService.decrypt(
          account.encrypted_access_token,
        );
      } catch (decryptError) {
        const message =
          decryptError instanceof Error
            ? decryptError.message
            : 'Unknown decrypt error';
        this.logger.error(
          `Failed to decrypt access token for social_account=${account.id}: ${message}`,
        );
        continue;
      }

      activeStates.push({
        sync_state_id: row.id,
        tenant_id: row.tenant_id,
        social_account_id: row.social_account_id,
        platform: account.platform,
        platform_account_id: account.platform_account_id,
        platform_username: account.platform_username,
        last_cursor_id: row.last_cursor_id,
        last_synced_at: row.last_synced_at,
        token_expires_at: account.token_expires_at,
        decrypted_access_token: decryptedAccessToken,
      });
    }

    return activeStates;
  }

  async updateCursor(syncStateId: string, lastCursorId: string) {
    const supabase = this.databaseService.getClient();
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from('sync_state')
      .update({
        last_cursor_id: lastCursorId,
        last_synced_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', syncStateId)
      .select('id, last_cursor_id, last_synced_at, updated_at')
      .single();

    if (error) {
      this.logger.error(
        `Failed to update cursor for sync_state=${syncStateId}: ${error.message}`,
      );
      throw new InternalServerErrorException('Failed to update cursor');
    }

    return {
      status: 'updated',
      sync_state_id: data.id,
      last_cursor_id: data.last_cursor_id,
      last_synced_at: data.last_synced_at,
      updated_at: data.updated_at,
    };
  }
}
