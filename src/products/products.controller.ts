import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { ProductsService, CreateDraftProductParams } from './products.service';

@Controller('api/v1/products')
export class ProductsController {
    constructor(private readonly productsService: ProductsService) { }

    /**
     * Protected endpoint called exclusively by n8n after the AI analysis completes.
     * Expects the full AI generated JSON schema + minio media urls to insert a Draft product.
     */
    @Post('draft')
    async createDraftProduct(
        @Body('tenant_id') tenantId: string,
        @Body('source_post_id') sourcePostId: string,
        @Body('title') title: string,
        @Body('price') price: number,
        @Body('ai_metadata') aiMetadata: any,
        @Body('media_urls') mediaUrls: string[],
    ) {
        if (!tenantId || !title || !aiMetadata) {
            throw new HttpException('Missing required fields for Draft Product insertion', HttpStatus.BAD_REQUEST);
        }

        const params: CreateDraftProductParams = {
            tenantId,
            sourcePostId,
            title,
            price,
            aiMetadata,
            mediaUrls
        };

        return await this.productsService.createDraftProduct(params);
    }
}
