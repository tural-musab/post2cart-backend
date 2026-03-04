import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface CreateDraftProductParams {
    tenantId: string;
    sourcePostId?: string;
    title: string;
    price?: number;
    aiMetadata: any;
    mediaUrls: string[];
}

@Injectable()
export class ProductsService {
    private readonly logger = new Logger(ProductsService.name);

    constructor(private readonly db: DatabaseService) { }

    /**
     * Called by n8n Webhook to insert a newly generated draft product safely.
     * Ensures the backend strictly handles the tenant_id binding, not n8n directly.
     */
    async createDraftProduct(params: CreateDraftProductParams) {
        const supabase = this.db.getClient();

        try {
            this.logger.log(`[${params.tenantId}] Creating draft product: ${params.title}`);

            // 1. Insert into Products table
            const { data: product, error: productError } = await supabase
                .from('products')
                .insert({
                    tenant_id: params.tenantId,
                    source_post_id: params.sourcePostId,
                    title: params.title,
                    slug: `${params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
                    price: params.price || 0,
                    ai_generated_metadata: params.aiMetadata,
                    status: 'draft',
                })
                .select('id')
                .single();

            if (productError) {
                throw new Error(`Failed to insert product: ${productError.message}`);
            }

            // 2. Insert Medias (Wait for all to finish)
            if (params.mediaUrls && params.mediaUrls.length > 0) {
                const mediaPayloads = params.mediaUrls.map((url, index) => ({
                    tenant_id: params.tenantId,
                    product_id: product.id,
                    file_url: url,
                    media_type: url.includes('.mp4') ? 'video' : 'image', // Basic assumption
                    is_primary: index === 0,
                }));

                const { error: mediaError } = await supabase
                    .from('product_media')
                    .insert(mediaPayloads);

                if (mediaError) {
                    throw new Error(`Failed to bind product media: ${mediaError.message}`);
                }
            }

            // 3. Log Audit Success
            await this.logAuditEvent(params.tenantId, 'ai_analysis_completed', {
                product_id: product.id,
                title: params.title
            });

            return {
                status: 'success',
                product_id: product.id,
            };

        } catch (error) {
            this.logger.error(`[${params.tenantId}] Draft creation failed: ${error.message}`);

            // 4. Log Audit Failure
            await this.logAuditEvent(params.tenantId, 'ai_analysis_failed', {
                error: error.message,
                source_post_id: params.sourcePostId
            });

            throw new InternalServerErrorException(error.message);
        }
    }

    private async logAuditEvent(tenantId: string, eventType: string, payload: any) {
        const supabase = this.db.getClient();
        const { error } = await supabase.from('audit_log').insert({
            tenant_id: tenantId,
            event_type: eventType,
            payload: payload
        });

        if (error) {
            this.logger.error(`Audit log failed: ${error.message}`);
        }
    }
}
