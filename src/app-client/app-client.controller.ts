import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { User } from '@supabase/supabase-js';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SupabaseJwtGuard } from '../auth/guards/supabase-jwt.guard';
import { AppClientService } from './app-client.service';
import { ConnectInstagramManualDto } from './dto/connect-instagram-manual.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { FinalizeInstagramOauthDto } from './dto/finalize-instagram-oauth.dto';
import { PublishAppProductDto } from './dto/publish-app-product.dto';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1/app')
export class AppClientController {
  constructor(private readonly appClientService: AppClientService) {}

  @Get('bootstrap')
  @UseGuards(SupabaseJwtGuard)
  async bootstrap(@CurrentUser() user: User | undefined): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }
    return this.appClientService.getBootstrap(user);
  }

  @Post('tenants')
  @UseGuards(SupabaseJwtGuard)
  async createTenant(
    @CurrentUser() user: User | undefined,
    @Body() body: CreateTenantDto,
  ): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }
    return this.appClientService.createTenant(user, body);
  }

  @Get('onboarding/status')
  @UseGuards(SupabaseJwtGuard)
  async onboardingStatus(@CurrentUser() user: User | undefined): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }
    return this.appClientService.getOnboardingStatus(user.id);
  }

  @Post('social-accounts/instagram/manual')
  @UseGuards(SupabaseJwtGuard)
  async connectInstagramManual(
    @CurrentUser() user: User | undefined,
    @Body() body: ConnectInstagramManualDto,
  ): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }
    return this.appClientService.connectInstagramManual(user.id, body);
  }

  @Get('products')
  @UseGuards(SupabaseJwtGuard)
  async getProducts(@CurrentUser() user: User | undefined): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }
    return this.appClientService.getProducts(user.id);
  }

  @Patch('products/:id/publish')
  @UseGuards(SupabaseJwtGuard)
  async publishProduct(
    @CurrentUser() user: User | undefined,
    @Param('id') productId: string,
    @Body() body: PublishAppProductDto,
  ): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }

    if (!productId || !UUID_REGEX.test(productId)) {
      throw new BadRequestException('Product ID must be a valid UUID');
    }
    if (body.price === undefined || body.price === null) {
      throw new BadRequestException('price is required');
    }

    return this.appClientService.publishProduct(user.id, productId, body.price);
  }

  @Get('social/instagram/oauth/start')
  @UseGuards(SupabaseJwtGuard)
  async oauthStart(@CurrentUser() user: User | undefined): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }
    return this.appClientService.getInstagramOauthStart(user.id);
  }

  @Get('social/instagram/oauth/callback')
  async oauthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() response: any,
  ): Promise<void> {
    const redirectUrl = await this.appClientService.instagramOauthCallback(
      code,
      state,
    );
    response.redirect(302, redirectUrl);
  }

  @Get('social/instagram/oauth/pending/:sessionId')
  @UseGuards(SupabaseJwtGuard)
  async oauthPending(
    @CurrentUser() user: User | undefined,
    @Param('sessionId') sessionId: string,
  ): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }

    return this.appClientService.getPendingInstagramOauthSession(
      user.id,
      sessionId,
    );
  }

  @Post('social/instagram/oauth/finalize')
  @UseGuards(SupabaseJwtGuard)
  async oauthFinalize(
    @CurrentUser() user: User | undefined,
    @Body() body: FinalizeInstagramOauthDto,
  ): Promise<any> {
    if (!user) {
      throw new BadRequestException('Authenticated user context is missing');
    }

    return this.appClientService.finalizeInstagramOauth(user.id, body);
  }
}
