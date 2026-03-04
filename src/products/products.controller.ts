import { Controller, Post, Get, Patch, Body, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ProductsService, CreateDraftProductParams } from './products.service';
import { PublishProductDto } from './dto/publish-product.dto';

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

    /**
     * Fetches a public, published product by slug. Used by Next.js SSR.
     */
    @Get('public/:slug')
    async getPublicProduct(@Param('slug') slug: string) {
        if (!slug) {
            throw new HttpException('Slug is required', HttpStatus.BAD_REQUEST);
        }
        return await this.productsService.getPublicProductBySlug(slug);
    }

    /**
     * Fetches products for a specific tenant (for the Dashboard).
       */
    @Get()
    async getProducts(@Query('tenantId') tenantId: string) {
        if (!tenantId) {
            throw new HttpException('Tenant ID is required', HttpStatus.BAD_REQUEST);
        }
        return await this.productsService.getProductsByTenant(tenantId);
    }

    /**
     * Publishes a draft product by setting its price and changing status to 'published'.
     */
    @Patch(':id/publish')
    async publishProduct(
        @Param('id') productId: string,
        @Body() publishDto: PublishProductDto,
    ) {
        if (!publishDto.tenantId || publishDto.price === undefined) {
            throw new HttpException('Missing tenantId or price', HttpStatus.BAD_REQUEST);
        }
        return await this.productsService.publishProduct(productId, publishDto);
    }
}
