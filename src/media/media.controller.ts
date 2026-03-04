import { Controller, Post, Body, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { MediaService } from './media.service';

@Controller('api/v1/media')
export class MediaController {
    constructor(private readonly mediaService: MediaService) { }

    /**
     * Endpoint for n8n to send a video url for processing.
     * Responds immediately with 202 ACCEPTED to unblock the n8n workflow.
     * Background process will download, extract keyframes, upload to S3, and trigger the webhook.
     */
    @Post('process-video')
    async processVideo(
        @Body('tenant_id') tenantId: string,
        @Body('platform_post_id') platformPostId: string,
        @Body('media_url') mediaUrl: string,
        @Body('n8n_callback_url') n8nCallbackUrl: string,
        @Body('payload') payloadInfo: any,
        @Res() res: Response // Inject response to send 202 explicitly and prematurely
    ) {
        if (!tenantId || !platformPostId || !mediaUrl || !n8nCallbackUrl) {
            return res.status(HttpStatus.BAD_REQUEST).json({
                status: 'error',
                message: 'Missing required parameters: tenant_id, platform_post_id, media_url, n8n_callback_url'
            });
        }

        // 1. Immediately return 202 Accepted. The connection closes so n8n can wait via webhook.
        res.status(HttpStatus.ACCEPTED).json({
            status: 'accepted',
            message: 'Video processing started asynchronously. Webhook will be called upon completion.',
            platform_post_id: platformPostId,
        });

        // 2. Fire and Forget the actual heavy lifting in the background
        this.mediaService.processMediaAsync(
            tenantId,
            platformPostId,
            mediaUrl,
            n8nCallbackUrl,
            payloadInfo
        );
    }
}
