import { Controller, Post, Body, HttpException, HttpStatus, Logger, UseGuards } from '@nestjs/common';

@Controller('api/v1/webhooks')
export class N8nWebhookController {
    private readonly logger = new Logger(N8nWebhookController.name);

    /**
     * Endpoint where n8n Sub-Workflows push fetched social posts.
     * Supabase insertion logic goes here, enforcing RLS.
     */
    @Post('social-posts')
    async receiveSocialPost(
        @Body('tenant_id') tenantId: string,
        @Body('platform') platform: string,
        @Body('platform_post_id') platformPostId: string,
        @Body('content') content: any,
    ) {
        if (!tenantId || !platform || !platformPostId) {
            throw new HttpException('Missing required generic fields', HttpStatus.BAD_REQUEST);
        }

        this.logger.log(`Received ${platform} post ${platformPostId} for tenant ${tenantId}`);

        // Here we will use the Supabase client initialized with the specific Tenant Service Role
        // to write into the social_posts table safely behind RLS.
        // e.g. await this.supabaseService.insertSocialPost(tenantId, ...);

        return { id: 'dummy-uuid-123', status: 'success' };
    }

    /**
     * DLQ Error Logger
     * n8n Error Trigger nodes post their failed items here.
     */
    @Post('failed-items')
    async logFailedItem(
        @Body('tenant_id') tenantId: string,
        @Body('workflow_name') workflowName: string,
        @Body('error_reason') errorReason: string,
        @Body('payload') payload: any,
    ) {
        this.logger.error(`DLQ Event: Workflow ${workflowName} failed for tenant ${tenantId}. Reason: ${errorReason}`);

        // Insert into Supabase `failed_items` table

        return { status: 'logged' };
    }
}
