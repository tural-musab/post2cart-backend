import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../crypto/crypto.service';

interface ProductRow {
  id: string;
  tenant_id: string;
  source_post_id: string | null;
  title: string;
  slug: string;
  status: string;
}

interface SocialPostRow {
  id: string;
  tenant_id: string;
  social_account_id: string | null;
  platform: string;
  platform_post_id: string;
}

interface SocialAccountRow {
  id: string;
  tenant_id: string;
  platform: string;
  encrypted_access_token: string;
  status: string;
}

export interface InstagramCommentPayload {
  tenantId: string;
  productId: string;
  commentTemplate?: string;
}

@Injectable()
export class SocialFeedbackService {
  private readonly logger = new Logger(SocialFeedbackService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
    private readonly configService: ConfigService,
  ) {}

  async commentProductLinkOnInstagram(payload: InstagramCommentPayload) {
    const supabase = this.databaseService.getClient();

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, tenant_id, source_post_id, title, slug, status')
      .eq('id', payload.productId)
      .eq('tenant_id', payload.tenantId)
      .single<ProductRow>();

    if (productError || !product) {
      throw new NotFoundException('Product not found for tenant');
    }

    if (product.status !== 'published') {
      throw new BadRequestException('Product must be published before feedback');
    }

    if (!product.source_post_id) {
      throw new BadRequestException(
        'Published product does not have a source social post reference',
      );
    }

    const { data: socialPost, error: socialPostError } = await supabase
      .from('social_posts')
      .select('id, tenant_id, social_account_id, platform, platform_post_id')
      .eq('id', product.source_post_id)
      .eq('tenant_id', payload.tenantId)
      .single<SocialPostRow>();

    if (socialPostError || !socialPost) {
      throw new BadRequestException('Source social post not found');
    }

    if (socialPost.platform !== 'instagram') {
      throw new BadRequestException('Feedback loop is only implemented for Instagram');
    }

    const socialAccount = await this.resolveInstagramSocialAccount(
      payload.tenantId,
      socialPost.social_account_id,
    );

    if (!socialAccount) {
      throw new NotFoundException(
        'No active Instagram social account found for tenant',
      );
    }

    let decryptedAccessToken: string;
    try {
      decryptedAccessToken = this.cryptoService.decrypt(
        socialAccount.encrypted_access_token,
      );
    } catch (decryptError) {
      const message =
        decryptError instanceof Error
          ? decryptError.message
          : 'Unknown decrypt error';
      throw new InternalServerErrorException(
        `Failed to decrypt Instagram access token: ${message}`,
      );
    }

    const publicStoreBaseUrl = (
      this.configService.get<string>('PUBLIC_STORE_BASE_URL') ?? ''
    ).replace(/\/+$/, '');

    if (!publicStoreBaseUrl) {
      throw new InternalServerErrorException(
        'PUBLIC_STORE_BASE_URL is not configured',
      );
    }

    const productUrl = `${publicStoreBaseUrl}/products/${product.slug}`;

    const commentMessage = payload.commentTemplate
      ? payload.commentTemplate
          .replaceAll('{{product_url}}', productUrl)
          .replaceAll('{{product_title}}', product.title)
      : `Urun linki bio'da: ${productUrl}`;

    const graphVersion =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v20.0';

    const graphEndpoint = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(
      socialPost.platform_post_id,
    )}/comments`;

    try {
      const body = new URLSearchParams({
        message: commentMessage,
        access_token: decryptedAccessToken,
      });

      const response = await axios.post<{ id?: string }>(
        graphEndpoint,
        body.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      await this.logAuditEvent(payload.tenantId, 'instagram_comment_posted', {
        product_id: product.id,
        source_post_id: socialPost.id,
        media_id: socialPost.platform_post_id,
        graph_comment_id: response.data?.id ?? null,
        product_url: productUrl,
      });

      return {
        status: 'success',
        product_id: product.id,
        source_post_id: socialPost.id,
        media_id: socialPost.platform_post_id,
        graph_comment_id: response.data?.id ?? null,
        product_url: productUrl,
      };
    } catch (error) {
      const details = axios.isAxiosError(error)
        ? error.response?.data ?? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown Instagram API error';

      await this.logAuditEvent(payload.tenantId, 'instagram_comment_failed', {
        product_id: product.id,
        source_post_id: socialPost.id,
        media_id: socialPost.platform_post_id,
        error: details,
      });

      this.logger.error(
        `Failed Instagram comment for product=${product.id} tenant=${payload.tenantId}: ${JSON.stringify(
          details,
        )}`,
      );

      throw new InternalServerErrorException(
        'Instagram Graph API comment request failed',
      );
    }
  }

  private async resolveInstagramSocialAccount(
    tenantId: string,
    socialAccountId: string | null,
  ): Promise<SocialAccountRow | null> {
    const supabase = this.databaseService.getClient();

    if (socialAccountId) {
      const { data } = await supabase
        .from('social_accounts')
        .select('id, tenant_id, platform, encrypted_access_token, status')
        .eq('id', socialAccountId)
        .eq('tenant_id', tenantId)
        .eq('platform', 'instagram')
        .eq('status', 'active')
        .maybeSingle<SocialAccountRow>();

      if (data) {
        return data;
      }
    }

    const { data } = await supabase
      .from('social_accounts')
      .select('id, tenant_id, platform, encrypted_access_token, status')
      .eq('tenant_id', tenantId)
      .eq('platform', 'instagram')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle<SocialAccountRow>();

    return data ?? null;
  }

  private async logAuditEvent(
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    const supabase = this.databaseService.getClient();
    const { error } = await supabase.from('audit_log').insert({
      tenant_id: tenantId,
      event_type: eventType,
      payload,
    });

    if (error) {
      this.logger.error(
        `Failed to insert audit log (${eventType}) for tenant=${tenantId}: ${error.message}`,
      );
    }
  }
}
