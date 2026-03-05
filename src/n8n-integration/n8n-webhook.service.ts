import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface IngestSocialPostPayload {
  tenantId: string;
  socialAccountId?: string;
  platform: string;
  platformPostId: string;
  content: Record<string, unknown>;
}

export interface LogFailedItemPayload {
  tenantId: string;
  workflowName: string;
  nodeName?: string;
  payload?: Record<string, unknown>;
  errorReason: string;
  retryCount?: number;
}

@Injectable()
export class N8nWebhookService {
  private readonly logger = new Logger(N8nWebhookService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async ingestSocialPost(payload: IngestSocialPostPayload) {
    const supabase = this.databaseService.getClient();

    const { data, error } = await supabase
      .from('social_posts')
      .insert({
        tenant_id: payload.tenantId,
        social_account_id: payload.socialAccountId ?? null,
        platform: payload.platform,
        platform_post_id: payload.platformPostId,
        content: payload.content,
      })
      .select('id, tenant_id, platform, platform_post_id, created_at')
      .single();

    if (error && error.code === '23505') {
      this.logger.warn(
        `Duplicate social post detected (${payload.platform}:${payload.platformPostId}) for tenant=${payload.tenantId}`,
      );

      const { data: existing, error: existingError } = await supabase
        .from('social_posts')
        .select('id, tenant_id, platform, platform_post_id, created_at')
        .eq('tenant_id', payload.tenantId)
        .eq('platform', payload.platform)
        .eq('platform_post_id', payload.platformPostId)
        .single();

      if (existingError || !existing) {
        throw new InternalServerErrorException(
          `Duplicate detected but failed to load existing record: ${existingError?.message ?? 'unknown'}`,
        );
      }

      return {
        status: 'duplicate',
        id: existing.id,
        tenant_id: existing.tenant_id,
        platform: existing.platform,
        platform_post_id: existing.platform_post_id,
        content: payload.content,
        media_type:
          typeof payload.content?.media_type === 'string'
            ? payload.content.media_type
            : null,
        created_at: existing.created_at,
      };
    }

    if (error) {
      throw new InternalServerErrorException(
        `Failed to ingest social post: ${error.message}`,
      );
    }

    return {
      status: 'inserted',
      id: data.id,
      tenant_id: data.tenant_id,
      platform: data.platform,
      platform_post_id: data.platform_post_id,
      content: payload.content,
      media_type:
        typeof payload.content?.media_type === 'string'
          ? payload.content.media_type
          : null,
      created_at: data.created_at,
    };
  }

  async logFailedItem(payload: LogFailedItemPayload) {
    const supabase = this.databaseService.getClient();

    const { data, error } = await supabase
      .from('failed_items')
      .insert({
        tenant_id: payload.tenantId,
        workflow_name: payload.workflowName,
        node_name: payload.nodeName ?? null,
        payload: payload.payload ?? {},
        error_reason: payload.errorReason,
        retry_count: payload.retryCount ?? 0,
        status: 'pending',
      })
      .select('id, tenant_id, workflow_name, node_name, status, created_at')
      .single();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to log failed item: ${error.message}`,
      );
    }

    return {
      status: 'logged',
      id: data.id,
      tenant_id: data.tenant_id,
      workflow_name: data.workflow_name,
      node_name: data.node_name,
      state: data.status,
      created_at: data.created_at,
    };
  }
}
