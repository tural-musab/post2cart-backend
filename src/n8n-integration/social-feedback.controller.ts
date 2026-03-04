import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalServiceTokenGuard } from '../common/guards/internal-service-token.guard';
import { SocialFeedbackService } from './social-feedback.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1/social/instagram')
@UseGuards(InternalServiceTokenGuard)
export class SocialFeedbackController {
  constructor(private readonly socialFeedbackService: SocialFeedbackService) {}

  @Post('comment-product-link')
  async commentProductLink(
    @Body('tenant_id') tenantId: string,
    @Body('product_id') productId: string,
    @Body('comment_template') commentTemplate?: string,
  ) {
    if (!tenantId || !productId) {
      throw new HttpException(
        'Missing required fields: tenant_id, product_id',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('tenant_id must be a valid UUID');
    }

    if (!UUID_REGEX.test(productId)) {
      throw new BadRequestException('product_id must be a valid UUID');
    }

    return this.socialFeedbackService.commentProductLinkOnInstagram({
      tenantId,
      productId,
      commentTemplate,
    });
  }
}
