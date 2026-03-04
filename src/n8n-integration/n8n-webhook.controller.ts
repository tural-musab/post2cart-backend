import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  LogFailedItemPayload,
  N8nWebhookService,
} from './n8n-webhook.service';
import { InternalServiceTokenGuard } from '../common/guards/internal-service-token.guard';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1/webhooks')
@UseGuards(InternalServiceTokenGuard)
export class N8nWebhookController {
  constructor(private readonly n8nWebhookService: N8nWebhookService) {}

  @Post('social-posts')
  async receiveSocialPost(
    @Body('tenant_id') tenantId: string,
    @Body('social_account_id') socialAccountId: string | undefined,
    @Body('platform') platform: string,
    @Body('platform_post_id') platformPostId: string,
    @Body('content') content: Record<string, unknown> | undefined,
  ) {
    if (!tenantId || !platform || !platformPostId) {
      throw new HttpException(
        'Missing required generic fields',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('tenant_id must be a valid UUID');
    }

    if (socialAccountId && !UUID_REGEX.test(socialAccountId)) {
      throw new BadRequestException('social_account_id must be a valid UUID');
    }

    return this.n8nWebhookService.ingestSocialPost({
      tenantId,
      socialAccountId,
      platform,
      platformPostId,
      content: content ?? {},
    });
  }

  @Post('failed-items')
  async logFailedItem(
    @Body('tenant_id') tenantId: string,
    @Body('workflow_name') workflowName: string,
    @Body('node_name') nodeName: string | undefined,
    @Body('payload') payload: Record<string, unknown> | undefined,
    @Body('error_reason') errorReason: string,
    @Body('retry_count') retryCount: number | undefined,
  ) {
    if (!tenantId || !workflowName || !errorReason) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }

    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('tenant_id must be a valid UUID');
    }

    const failedPayload: LogFailedItemPayload = {
      tenantId,
      workflowName,
      nodeName,
      payload,
      errorReason,
      retryCount,
    };

    return this.n8nWebhookService.logFailedItem(failedPayload);
  }
}
