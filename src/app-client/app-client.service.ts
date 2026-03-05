import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@supabase/supabase-js';
import axios from 'axios';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { CryptoService } from '../crypto/crypto.service';
import { DatabaseService } from '../database/database.service';
import { AutomationFailedItemsQueryDto } from './dto/automation-failed-items-query.dto';
import { AutomationOpsQueryDto } from './dto/automation-ops-query.dto';
import { ConnectInstagramManualDto } from './dto/connect-instagram-manual.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { FinalizeInstagramOauthDto } from './dto/finalize-instagram-oauth.dto';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OAUTH_STATE_TTL_MINUTES = 15;

type TokenSource = 'manual' | 'facebook_oauth';

interface TenantRow {
  id: string;
  name: string;
  created_at: string;
}

interface MembershipRow {
  tenant_id: string;
  role: string;
  created_at: string;
  tenants: TenantRow[] | TenantRow | null;
}

interface SocialAccountRow {
  id: string;
  tenant_id: string;
  platform: string;
  platform_account_id: string;
  platform_username: string | null;
  token_expires_at: string | null;
  status: string;
  token_source: TokenSource | null;
  updated_at: string;
}

interface OAuthCandidate {
  page_id: string;
  page_name: string;
  platform_account_id: string;
  platform_username: string | null;
}

interface OAuthSessionRow {
  id: string;
  user_id: string;
  tenant_id: string;
  provider: string;
  status: string;
  state_nonce: string;
  state_expires_at: string;
  encrypted_access_token: string | null;
  token_expires_at: string | null;
  candidates: OAuthCandidate[] | null;
  selected_platform_account_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
}

type AutomationExecutionStatus = 'started' | 'success' | 'failed';
type RetryJobStatus = 'queued' | 'processing' | 'completed' | 'failed';
type FailedItemStatus = 'pending' | 'resolved' | 'ignored';

interface AutomationExecutionRow {
  id: string;
  tenant_id: string;
  workflow_name: string;
  external_execution_id: string;
  status: AutomationExecutionStatus;
  node_name: string | null;
  error_reason: string | null;
  meta: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FailedItemRow {
  id: string;
  tenant_id: string;
  workflow_name: string;
  node_name: string | null;
  payload: Record<string, unknown> | null;
  error_reason: string;
  retry_count: number;
  status: FailedItemStatus;
  created_at: string;
  updated_at: string;
  last_retry_at: string | null;
  last_retry_job_id: string | null;
}

interface RetryJobRow {
  id: string;
  tenant_id: string;
  failed_item_id: string;
  status: RetryJobStatus;
  retry_context: Record<string, unknown>;
  attempt_number: number;
  claimed_by: string | null;
  error_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GraphAccessTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface GraphPageAccount {
  id: string;
  name: string;
  instagram_business_account?: {
    id: string;
    username?: string;
  };
}

interface GraphPageAccountsResponse {
  data?: GraphPageAccount[];
}

@Injectable()
export class AppClientService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
    private readonly configService: ConfigService,
  ) {}

  async getBootstrap(user: User) {
    const tenant = await this.getPrimaryTenant(user.id);
    const onboardingStatus = await this.getOnboardingStatus(user.id);
    const recentProducts = tenant ? await this.fetchTenantProducts(tenant.id, 6) : [];

    return {
      user: {
        id: user.id,
        email: user.email ?? null,
      },
      tenant,
      onboarding_status: onboardingStatus,
      recent_products: recentProducts,
      automation_ready: onboardingStatus.automation_ready,
    };
  }

  async createTenant(user: User, payload: CreateTenantDto) {
    const name = payload.name?.trim();
    if (!name) {
      throw new BadRequestException('Tenant name is required');
    }

    const supabase = this.databaseService.getClient();
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({ name })
      .select('id, name, created_at')
      .single<TenantRow>();

    if (tenantError || !tenant) {
      throw new InternalServerErrorException(
        `Failed to create tenant: ${tenantError?.message ?? 'unknown error'}`,
      );
    }

    const { error: membershipError } = await supabase.from('memberships').insert({
      tenant_id: tenant.id,
      user_id: user.id,
      role: 'owner',
    });

    if (membershipError) {
      throw new InternalServerErrorException(
        `Failed to create membership: ${membershipError.message}`,
      );
    }

    return {
      status: 'success',
      tenant,
    };
  }

  async getOnboardingStatus(userId: string) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      return {
        has_tenant: false,
        has_social_account: false,
        has_sync_state: false,
        token_valid: false,
        automation_ready: false,
      };
    }

    const supabase = this.databaseService.getClient();
    const { data: socialAccount } = await supabase
      .from('social_accounts')
      .select(
        'id, tenant_id, platform, platform_account_id, platform_username, token_expires_at, status, token_source, updated_at',
      )
      .eq('tenant_id', tenant.id)
      .eq('platform', 'instagram')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle<SocialAccountRow>();

    const { count: syncStateCount } = await supabase
      .from('sync_state')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('is_active', true);

    const hasSocialAccount = Boolean(socialAccount);
    const hasSyncState = (syncStateCount ?? 0) > 0;
    const tokenValid = this.isTokenValid(socialAccount?.token_expires_at ?? null);

    return {
      has_tenant: true,
      has_social_account: hasSocialAccount,
      has_sync_state: hasSyncState,
      token_valid: tokenValid,
      automation_ready: hasSocialAccount && hasSyncState && tokenValid,
      active_social_account: socialAccount
        ? {
            id: socialAccount.id,
            platform_account_id: socialAccount.platform_account_id,
            platform_username: socialAccount.platform_username,
            token_expires_at: socialAccount.token_expires_at,
            token_source: socialAccount.token_source,
          }
        : null,
    };
  }

  async connectInstagramManual(userId: string, payload: ConnectInstagramManualDto) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      throw new BadRequestException('No tenant found for user. Create a tenant first.');
    }

    const platformAccountId = payload.platform_account_id?.trim();
    const accessToken = payload.access_token?.trim();
    const platformUsername = payload.platform_username?.trim() || null;
    const tokenExpiresAt = payload.token_expires_at?.trim() || null;

    if (!platformAccountId || !accessToken) {
      throw new BadRequestException('platform_account_id and access_token are required');
    }

    if (tokenExpiresAt && Number.isNaN(new Date(tokenExpiresAt).getTime())) {
      throw new BadRequestException('token_expires_at must be a valid ISO datetime string');
    }

    return this.attachInstagramAccount({
      tenantId: tenant.id,
      platformAccountId,
      platformUsername,
      accessToken,
      tokenExpiresAt,
      tokenSource: 'manual',
      oauthScopes: null,
    });
  }

  async getProducts(userId: string) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      return [];
    }
    return this.fetchTenantProducts(tenant.id);
  }

  async publishProduct(userId: string, productId: string, price: number) {
    if (!Number.isFinite(price) || price < 0) {
      throw new BadRequestException('price must be a non-negative number');
    }

    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      throw new BadRequestException('No tenant found for user');
    }

    const supabase = this.databaseService.getClient();
    const { data: existing, error: existingError } = await supabase
      .from('products')
      .select('id, title, status')
      .eq('id', productId)
      .eq('tenant_id', tenant.id)
      .single();

    if (existingError || !existing) {
      throw new NotFoundException('Product not found');
    }

    if (existing.status === 'published') {
      return {
        status: 'already_published',
        product: existing,
      };
    }

    const { data: updated, error: updateError } = await supabase
      .from('products')
      .update({
        price,
        status: 'published',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', productId)
      .eq('tenant_id', tenant.id)
      .select('id, title, slug, status, price, published_at')
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException(
        `Failed to publish product: ${updateError?.message ?? 'unknown error'}`,
      );
    }

    await supabase.from('audit_log').insert({
      tenant_id: tenant.id,
      event_type: 'product_status_change',
      payload: {
        product_id: updated.id,
        title: updated.title,
        new_status: updated.status,
        new_price: updated.price,
      },
    });

    return {
      status: 'published',
      product: updated,
    };
  }

  async getAutomationOps(userId: string) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      return {
        tenant: null,
        summary: {
          pending_failed_count: 0,
          queued_retry_count: 0,
          processing_retry_count: 0,
          success_last_24h: 0,
          failed_last_24h: 0,
          last_execution: null,
        },
        recent_executions: [],
        failed_items: [],
      };
    }

    const supabase = this.databaseService.getClient();
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [
      pendingFailedResult,
      queuedRetryResult,
      processingRetryResult,
      successLast24Result,
      failedLast24Result,
      recentExecutionsResult,
      recentFailedItemsResult,
    ] = await Promise.all([
      supabase
        .from('failed_items')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'pending'),
      supabase
        .from('automation_retry_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'queued'),
      supabase
        .from('automation_retry_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'processing'),
      supabase
        .from('automation_executions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'success')
        .gte('created_at', sinceIso),
      supabase
        .from('automation_executions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'failed')
        .gte('created_at', sinceIso),
      supabase
        .from('automation_executions')
        .select(
          'id, tenant_id, workflow_name, external_execution_id, status, node_name, error_reason, meta, started_at, finished_at, created_at, updated_at',
        )
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('failed_items')
        .select(
          'id, tenant_id, workflow_name, node_name, payload, error_reason, retry_count, status, created_at, updated_at, last_retry_at, last_retry_job_id',
        )
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    if (
      pendingFailedResult.error ||
      queuedRetryResult.error ||
      processingRetryResult.error ||
      successLast24Result.error ||
      failedLast24Result.error ||
      recentExecutionsResult.error ||
      recentFailedItemsResult.error
    ) {
      throw new InternalServerErrorException('Failed to load automation ops summary');
    }

    const executions = (recentExecutionsResult.data ?? []).map((row) =>
      this.mapExecutionRow(row as AutomationExecutionRow),
    );

    const failedItems = (recentFailedItemsResult.data ?? []).map((row) =>
      this.mapFailedItemRow(row as FailedItemRow),
    );

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
      },
      summary: {
        pending_failed_count: pendingFailedResult.count ?? 0,
        queued_retry_count: queuedRetryResult.count ?? 0,
        processing_retry_count: processingRetryResult.count ?? 0,
        success_last_24h: successLast24Result.count ?? 0,
        failed_last_24h: failedLast24Result.count ?? 0,
        last_execution: executions[0] ?? null,
      },
      recent_executions: executions,
      failed_items: failedItems,
    };
  }

  async getAutomationExecutions(userId: string, query: AutomationOpsQueryDto) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      return {
        items: [],
        next_cursor: null,
      };
    }

    const limit = this.parseListLimit(query.limit, 20, 100);
    const cursor = this.parseOptionalIsoCursor(query.cursor);

    const supabase = this.databaseService.getClient();
    let dbQuery = supabase
      .from('automation_executions')
      .select(
        'id, tenant_id, workflow_name, external_execution_id, status, node_name, error_reason, meta, started_at, finished_at, created_at, updated_at',
      )
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) {
      dbQuery = dbQuery.lt('created_at', cursor);
    }

    const { data, error } = await dbQuery;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to fetch automation executions: ${error.message}`,
      );
    }

    const items = (data ?? []).map((row) =>
      this.mapExecutionRow(row as AutomationExecutionRow),
    );
    const nextCursor = items.length === limit ? items[items.length - 1].created_at : null;

    return {
      items,
      next_cursor: nextCursor,
    };
  }

  async getAutomationFailedItems(
    userId: string,
    query: AutomationFailedItemsQueryDto,
  ) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      return {
        items: [],
        next_cursor: null,
      };
    }

    const limit = this.parseListLimit(query.limit, 20, 100);
    const cursor = this.parseOptionalIsoCursor(query.cursor);
    const status = (query.status ?? 'pending').trim().toLowerCase();

    if (!['pending', 'resolved', 'ignored', 'all'].includes(status)) {
      throw new BadRequestException('status must be one of pending|resolved|ignored|all');
    }

    const supabase = this.databaseService.getClient();
    let dbQuery = supabase
      .from('failed_items')
      .select(
        'id, tenant_id, workflow_name, node_name, payload, error_reason, retry_count, status, created_at, updated_at, last_retry_at, last_retry_job_id',
      )
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status !== 'all') {
      dbQuery = dbQuery.eq('status', status);
    }
    if (cursor) {
      dbQuery = dbQuery.lt('created_at', cursor);
    }

    const { data, error } = await dbQuery;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to fetch failed items: ${error.message}`,
      );
    }

    const items = (data ?? []).map((row) => this.mapFailedItemRow(row as FailedItemRow));
    const nextCursor = items.length === limit ? items[items.length - 1].created_at : null;

    return {
      items,
      next_cursor: nextCursor,
    };
  }

  async retryAutomationFailedItem(userId: string, failedItemId: string, note?: string) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      throw new BadRequestException('No tenant found for user');
    }

    const supabase = this.databaseService.getClient();
    const { data: failedItem, error: failedItemError } = await supabase
      .from('failed_items')
      .select(
        'id, tenant_id, workflow_name, node_name, payload, error_reason, retry_count, status, created_at, updated_at, last_retry_at, last_retry_job_id',
      )
      .eq('id', failedItemId)
      .eq('tenant_id', tenant.id)
      .maybeSingle<FailedItemRow>();

    if (failedItemError || !failedItem) {
      throw new NotFoundException('Failed item not found');
    }

    if (failedItem.status !== 'pending') {
      throw new BadRequestException('Only pending failed items can be retried');
    }

    const retryContext = this.extractRetryContext(failedItem.payload, tenant.id);
    if (!retryContext) {
      return {
        status: 'not_retryable',
        reason: 'payload.retry_context is missing or invalid',
      };
    }

    const { data: activeJob, error: activeJobError } = await supabase
      .from('automation_retry_jobs')
      .select('id, status')
      .eq('failed_item_id', failedItemId)
      .in('status', ['queued', 'processing'])
      .limit(1)
      .maybeSingle<{ id: string; status: RetryJobStatus }>();

    if (activeJobError) {
      throw new InternalServerErrorException(
        `Failed to check active retry job: ${activeJobError.message}`,
      );
    }

    if (activeJob) {
      throw new ConflictException(
        `Retry already queued for this item (job_id=${activeJob.id}, status=${activeJob.status})`,
      );
    }

    const nowIso = new Date().toISOString();
    const { data: retryJob, error: retryJobError } = await supabase
      .from('automation_retry_jobs')
      .insert({
        tenant_id: tenant.id,
        failed_item_id: failedItem.id,
        status: 'queued',
        retry_context: retryContext,
        attempt_number: (failedItem.retry_count ?? 0) + 1,
        updated_at: nowIso,
      })
      .select(
        'id, tenant_id, failed_item_id, status, retry_context, attempt_number, claimed_by, error_reason, started_at, finished_at, created_at, updated_at',
      )
      .single<RetryJobRow>();

    if (retryJobError || !retryJob) {
      throw new InternalServerErrorException(
        `Failed to queue retry job: ${retryJobError?.message ?? 'unknown error'}`,
      );
    }

    const { error: failedItemUpdateError } = await supabase
      .from('failed_items')
      .update({
        last_retry_at: nowIso,
        last_retry_job_id: retryJob.id,
        updated_at: nowIso,
      })
      .eq('id', failedItem.id)
      .eq('tenant_id', tenant.id);

    if (failedItemUpdateError) {
      throw new InternalServerErrorException(
        `Failed to update failed item retry metadata: ${failedItemUpdateError.message}`,
      );
    }

    await this.logAuditEvent(tenant.id, 'automation_retry_queued', {
      failed_item_id: failedItem.id,
      retry_job_id: retryJob.id,
      workflow_name: failedItem.workflow_name,
      note: note?.trim() || null,
    });

    return {
      status: 'queued',
      retry_job_id: retryJob.id,
      failed_item_id: failedItem.id,
      queued_at: retryJob.created_at,
    };
  }

  async getInstagramOauthStart(userId: string) {
    const tenant = await this.getPrimaryTenant(userId);
    if (!tenant) {
      throw new BadRequestException('No tenant found for user. Create a tenant first.');
    }

    const appId = this.getRequiredConfig('META_APP_ID');
    const redirectUri = this.getRequiredConfig('META_REDIRECT_URI');
    const stateSigningKey = this.getRequiredConfig('OAUTH_STATE_SIGNING_KEY');
    const graphVersion = this.getGraphVersion();
    const requestedScopes = this.getRequestedScopesString();

    const now = Date.now();
    const stateNonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(now + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();

    const supabase = this.databaseService.getClient();
    const { data: oauthSession, error: oauthSessionError } = await supabase
      .from('oauth_sessions')
      .insert({
        user_id: userId,
        tenant_id: tenant.id,
        provider: 'instagram',
        status: 'started',
        state_nonce: stateNonce,
        state_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .select(
        'id, user_id, tenant_id, provider, status, state_nonce, state_expires_at, encrypted_access_token, token_expires_at, candidates, selected_platform_account_id, error_code, created_at, updated_at, consumed_at',
      )
      .single<OAuthSessionRow>();

    if (oauthSessionError || !oauthSession) {
      throw new InternalServerErrorException(
        `Failed to create OAuth session: ${oauthSessionError?.message ?? 'unknown error'}`,
      );
    }

    const payload = `${oauthSession.id}.${stateNonce}`;
    const signature = this.signStatePayload(payload, stateSigningKey);
    const state = `${payload}.${signature}`;

    const url = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', requestedScopes);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return {
      status: 'ready',
      authorization_url: url.toString(),
      session_id: oauthSession.id,
    };
  }

  async instagramOauthCallback(code?: string, state?: string): Promise<string> {
    const frontendBaseUrl = this.getFrontendBaseUrl();

    if (!code || !state) {
      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'missing_code_or_state',
      });
    }

    const parsedState = this.parseState(state);
    if (!parsedState) {
      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'invalid_state',
      });
    }

    const { sessionId, nonce, signature } = parsedState;

    const supabase = this.databaseService.getClient();
    const { data: session, error: sessionError } = await supabase
      .from('oauth_sessions')
      .select(
        'id, user_id, tenant_id, provider, status, state_nonce, state_expires_at, encrypted_access_token, token_expires_at, candidates, selected_platform_account_id, error_code, created_at, updated_at, consumed_at',
      )
      .eq('id', sessionId)
      .eq('provider', 'instagram')
      .maybeSingle<OAuthSessionRow>();

    if (sessionError || !session) {
      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'session_not_found',
      });
    }

    const stateSigningKey = this.getRequiredConfig('OAUTH_STATE_SIGNING_KEY');
    const payload = `${session.id}.${nonce}`;
    const expectedSignature = this.signStatePayload(payload, stateSigningKey);
    const signatureValid = this.compareSignatures(signature, expectedSignature);

    if (!signatureValid || nonce !== session.state_nonce) {
      await this.markOauthSessionStatus(session.id, 'error', {
        errorCode: 'state_signature_invalid',
      });
      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'state_signature_invalid',
      });
    }

    const expiresAtMs = new Date(session.state_expires_at).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      await this.markOauthSessionStatus(session.id, 'expired', {
        errorCode: 'state_expired',
      });
      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'state_expired',
      });
    }

    if (session.status === 'connected' || session.status === 'consumed') {
      return this.buildOnboardingRedirect(frontendBaseUrl, 'success');
    }

    if (session.status !== 'started' && session.status !== 'pending_selection') {
      await this.markOauthSessionStatus(session.id, 'error', {
        errorCode: 'invalid_session_status',
      });
      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'invalid_session_status',
      });
    }

    try {
      const tokenResponse = await this.exchangeInstagramCodeToLongLivedToken(code);
      const accessToken = tokenResponse.accessToken;
      const tokenExpiresAt = tokenResponse.tokenExpiresAt;
      const candidates = await this.fetchInstagramCandidates(accessToken);

      if (candidates.length === 0) {
        await this.markOauthSessionStatus(session.id, 'error', {
          errorCode: 'no_instagram_business_account',
        });
        return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
          reason: 'no_instagram_business_account',
        });
      }

      if (candidates.length === 1) {
        await this.attachInstagramAccount({
          tenantId: session.tenant_id,
          platformAccountId: candidates[0].platform_account_id,
          platformUsername: candidates[0].platform_username,
          accessToken,
          tokenExpiresAt,
          tokenSource: 'facebook_oauth',
          oauthScopes: this.getRequestedScopes(),
        });

        await this.markOauthSessionStatus(session.id, 'connected', {
          selectedPlatformAccountId: candidates[0].platform_account_id,
          consumed: true,
          tokenExpiresAt,
        });

        return this.buildOnboardingRedirect(frontendBaseUrl, 'success');
      }

      await this.markOauthSessionStatus(session.id, 'pending_selection', {
        encryptedAccessToken: this.cryptoService.encrypt(accessToken),
        tokenExpiresAt,
        candidates,
      });

      return this.buildOnboardingRedirect(frontendBaseUrl, 'select', {
        session: session.id,
      });
    } catch (error) {
      const reason = axios.isAxiosError(error)
        ? `oauth_exchange_failed:${JSON.stringify(error.response?.data ?? error.message)}`
        : error instanceof Error
        ? error.message
        : 'oauth_exchange_failed';

      await this.markOauthSessionStatus(session.id, 'error', {
        errorCode: reason,
      });

      return this.buildOnboardingRedirect(frontendBaseUrl, 'error', {
        reason: 'oauth_exchange_failed',
      });
    }
  }

  async getPendingInstagramOauthSession(userId: string, sessionId: string) {
    if (!sessionId || !UUID_REGEX.test(sessionId)) {
      throw new BadRequestException('sessionId must be a valid UUID');
    }

    const supabase = this.databaseService.getClient();
    const { data: session, error } = await supabase
      .from('oauth_sessions')
      .select(
        'id, user_id, tenant_id, provider, status, state_nonce, state_expires_at, encrypted_access_token, token_expires_at, candidates, selected_platform_account_id, error_code, created_at, updated_at, consumed_at',
      )
      .eq('id', sessionId)
      .eq('provider', 'instagram')
      .eq('user_id', userId)
      .maybeSingle<OAuthSessionRow>();

    if (error || !session) {
      throw new NotFoundException('OAuth session not found');
    }

    if (session.status !== 'pending_selection') {
      throw new BadRequestException('OAuth session is not awaiting account selection');
    }

    const expiresAtMs = new Date(session.state_expires_at).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      await this.markOauthSessionStatus(session.id, 'expired', {
        errorCode: 'state_expired',
      });
      throw new BadRequestException('OAuth session expired');
    }

    const candidates = this.normalizeCandidates(session.candidates);

    return {
      status: 'pending_selection',
      session_id: session.id,
      candidates,
      expires_at: session.state_expires_at,
    };
  }

  async finalizeInstagramOauth(userId: string, payload: FinalizeInstagramOauthDto) {
    const sessionId = payload.session_id?.trim();
    const platformAccountId = payload.platform_account_id?.trim();

    if (!sessionId || !UUID_REGEX.test(sessionId)) {
      throw new BadRequestException('session_id must be a valid UUID');
    }

    if (!platformAccountId) {
      throw new BadRequestException('platform_account_id is required');
    }

    const supabase = this.databaseService.getClient();
    const { data: session, error } = await supabase
      .from('oauth_sessions')
      .select(
        'id, user_id, tenant_id, provider, status, state_nonce, state_expires_at, encrypted_access_token, token_expires_at, candidates, selected_platform_account_id, error_code, created_at, updated_at, consumed_at',
      )
      .eq('id', sessionId)
      .eq('provider', 'instagram')
      .eq('user_id', userId)
      .maybeSingle<OAuthSessionRow>();

    if (error || !session) {
      throw new NotFoundException('OAuth session not found');
    }

    if (session.status !== 'pending_selection') {
      throw new BadRequestException('OAuth session is not awaiting selection');
    }

    const expiresAtMs = new Date(session.state_expires_at).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      await this.markOauthSessionStatus(session.id, 'expired', {
        errorCode: 'state_expired',
      });
      throw new BadRequestException('OAuth session expired');
    }

    if (!session.encrypted_access_token) {
      throw new InternalServerErrorException(
        'OAuth session does not contain access token payload',
      );
    }

    const candidates = this.normalizeCandidates(session.candidates);
    const selectedCandidate = candidates.find(
      (candidate) => candidate.platform_account_id === platformAccountId,
    );

    if (!selectedCandidate) {
      throw new BadRequestException(
        'Selected platform_account_id is not part of pending candidates',
      );
    }

    const accessToken = this.cryptoService.decrypt(session.encrypted_access_token);

    const connected = await this.attachInstagramAccount({
      tenantId: session.tenant_id,
      platformAccountId: selectedCandidate.platform_account_id,
      platformUsername: selectedCandidate.platform_username,
      accessToken,
      tokenExpiresAt: session.token_expires_at,
      tokenSource: 'facebook_oauth',
      oauthScopes: this.getRequestedScopes(),
    });

    await this.markOauthSessionStatus(session.id, 'connected', {
      selectedPlatformAccountId: selectedCandidate.platform_account_id,
      consumed: true,
      tokenExpiresAt: session.token_expires_at,
    });

    return {
      status: 'connected',
      tenant_id: session.tenant_id,
      social_account: connected.social_account,
      sync_state: connected.sync_state,
      automation_ready: connected.automation_ready,
    };
  }

  private async attachInstagramAccount(params: {
    tenantId: string;
    platformAccountId: string;
    platformUsername: string | null;
    accessToken: string;
    tokenExpiresAt: string | null;
    tokenSource: TokenSource;
    oauthScopes: string[] | null;
  }) {
    const encryptedAccessToken = this.cryptoService.encrypt(params.accessToken);
    const nowIso = new Date().toISOString();
    const supabase = this.databaseService.getClient();

    const { data: socialAccount, error: socialAccountError } = await supabase
      .from('social_accounts')
      .upsert(
        {
          tenant_id: params.tenantId,
          platform: 'instagram',
          platform_account_id: params.platformAccountId,
          platform_username: params.platformUsername,
          encrypted_access_token: encryptedAccessToken,
          token_expires_at: params.tokenExpiresAt,
          status: 'active',
          token_source: params.tokenSource,
          oauth_scopes: params.oauthScopes,
          updated_at: nowIso,
        },
        {
          onConflict: 'platform,platform_account_id,tenant_id',
        },
      )
      .select(
        'id, tenant_id, platform, platform_account_id, platform_username, token_expires_at, status, token_source, updated_at',
      )
      .single<SocialAccountRow>();

    if (socialAccountError || !socialAccount) {
      throw new InternalServerErrorException(
        `Failed to save social account: ${socialAccountError?.message ?? 'unknown error'}`,
      );
    }

    const { data: syncState, error: syncStateError } = await supabase
      .from('sync_state')
      .upsert(
        {
          tenant_id: params.tenantId,
          social_account_id: socialAccount.id,
          is_active: true,
          updated_at: nowIso,
        },
        {
          onConflict: 'social_account_id',
        },
      )
      .select('id, social_account_id, tenant_id, is_active, last_cursor_id, last_synced_at')
      .single();

    if (syncStateError || !syncState) {
      throw new InternalServerErrorException(
        `Failed to save sync state: ${syncStateError?.message ?? 'unknown error'}`,
      );
    }

    await this.logAuditEvent(params.tenantId, 'instagram_account_connected', {
      social_account_id: socialAccount.id,
      platform_account_id: socialAccount.platform_account_id,
      token_source: socialAccount.token_source,
    });

    return {
      status: 'connected',
      tenant_id: params.tenantId,
      social_account: {
        id: socialAccount.id,
        platform: socialAccount.platform,
        platform_account_id: socialAccount.platform_account_id,
        platform_username: socialAccount.platform_username,
        token_expires_at: socialAccount.token_expires_at,
        status: socialAccount.status,
        token_source: socialAccount.token_source,
      },
      sync_state: syncState,
      automation_ready: this.isTokenValid(socialAccount.token_expires_at),
    };
  }

  private async exchangeInstagramCodeToLongLivedToken(code: string) {
    const appId = this.getRequiredConfig('META_APP_ID');
    const appSecret = this.getRequiredConfig('META_APP_SECRET');
    const redirectUri = this.getRequiredConfig('META_REDIRECT_URI');
    const graphVersion = this.getGraphVersion();

    const shortTokenResponse = await axios.get<GraphAccessTokenResponse>(
      `https://graph.facebook.com/${graphVersion}/oauth/access_token`,
      {
        params: {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code,
        },
      },
    );

    const shortAccessToken = shortTokenResponse.data.access_token;
    if (!shortAccessToken) {
      throw new InternalServerErrorException('Short-lived access token was not returned');
    }

    const longTokenResponse = await axios.get<GraphAccessTokenResponse>(
      `https://graph.facebook.com/${graphVersion}/oauth/access_token`,
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortAccessToken,
        },
      },
    );

    const accessToken = longTokenResponse.data.access_token ?? shortAccessToken;
    const expiresIn = Number(longTokenResponse.data.expires_in ?? 0);
    const tokenExpiresAt =
      expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    return {
      accessToken,
      tokenExpiresAt,
    };
  }

  private async fetchInstagramCandidates(accessToken: string): Promise<OAuthCandidate[]> {
    const graphVersion = this.getGraphVersion();
    const response = await axios.get<GraphPageAccountsResponse>(
      `https://graph.facebook.com/${graphVersion}/me/accounts`,
      {
        params: {
          fields: 'id,name,instagram_business_account{id,username}',
          access_token: accessToken,
          limit: 200,
        },
      },
    );

    const items = response.data.data ?? [];
    const candidates = items
      .filter((item) => Boolean(item.instagram_business_account?.id))
      .map((item) => ({
        page_id: item.id,
        page_name: item.name,
        platform_account_id: item.instagram_business_account!.id,
        platform_username: item.instagram_business_account?.username ?? null,
      }));

    const uniqueByAccount = new Map<string, OAuthCandidate>();
    for (const candidate of candidates) {
      uniqueByAccount.set(candidate.platform_account_id, candidate);
    }

    return Array.from(uniqueByAccount.values());
  }

  private async markOauthSessionStatus(
    sessionId: string,
    status: string,
    options?: {
      encryptedAccessToken?: string;
      tokenExpiresAt?: string | null;
      candidates?: OAuthCandidate[];
      selectedPlatformAccountId?: string;
      errorCode?: string;
      consumed?: boolean;
    },
  ) {
    const supabase = this.databaseService.getClient();
    const payload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (options?.encryptedAccessToken !== undefined) {
      payload.encrypted_access_token = options.encryptedAccessToken;
    }
    if (options?.tokenExpiresAt !== undefined) {
      payload.token_expires_at = options.tokenExpiresAt;
    }
    if (options?.candidates !== undefined) {
      payload.candidates = options.candidates;
    }
    if (options?.selectedPlatformAccountId !== undefined) {
      payload.selected_platform_account_id = options.selectedPlatformAccountId;
    }
    if (options?.errorCode !== undefined) {
      payload.error_code = options.errorCode;
    }
    if (options?.consumed) {
      payload.consumed_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('oauth_sessions')
      .update(payload)
      .eq('id', sessionId);

    if (error) {
      throw new InternalServerErrorException(
        `Failed to update oauth session state: ${error.message}`,
      );
    }
  }

  private normalizeCandidates(value: OAuthSessionRow['candidates']): OAuthCandidate[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is OAuthCandidate => {
      return (
        typeof item?.platform_account_id === 'string' &&
        typeof item?.page_id === 'string' &&
        typeof item?.page_name === 'string'
      );
    });
  }

  private parseState(state: string): {
    sessionId: string;
    nonce: string;
    signature: string;
  } | null {
    const parts = state.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [sessionId, nonce, signature] = parts;
    if (!UUID_REGEX.test(sessionId) || !nonce || !signature) {
      return null;
    }

    return {
      sessionId,
      nonce,
      signature,
    };
  }

  private signStatePayload(payload: string, key: string): string {
    return createHmac('sha256', key).update(payload).digest('hex');
  }

  private compareSignatures(received: string, expected: string): boolean {
    try {
      const a = Buffer.from(received, 'hex');
      const b = Buffer.from(expected, 'hex');
      if (a.length !== b.length) {
        return false;
      }
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private buildOnboardingRedirect(
    frontendBaseUrl: string,
    oauth: 'success' | 'error' | 'select',
    extras?: Record<string, string>,
  ) {
    const url = new URL('/onboarding', frontendBaseUrl);
    url.searchParams.set('oauth', oauth);
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private getGraphVersion() {
    return this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v20.0';
  }

  private getRequestedScopesString() {
    return this.configService.get<string>('META_OAUTH_SCOPES')
      ? this.configService.get<string>('META_OAUTH_SCOPES')!
      : 'instagram_basic,instagram_manage_comments,pages_show_list,pages_read_engagement';
  }

  private getRequestedScopes() {
    return this.getRequestedScopesString()
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private getFrontendBaseUrl() {
    const frontendBaseUrl = this.configService.get<string>('FRONTEND_BASE_URL');
    return (frontendBaseUrl ?? 'https://post2cart.com').replace(/\/+$/, '');
  }

  private getRequiredConfig(key: string) {
    const value = this.configService.get<string>(key);
    if (!value || !value.trim()) {
      throw new BadRequestException(`${key} is required`);
    }
    return value.trim();
  }

  private async getPrimaryTenant(userId: string): Promise<TenantRow | null> {
    const supabase = this.databaseService.getClient();
    const { data, error } = await supabase
      .from('memberships')
      .select(
        `
          tenant_id,
          role,
          created_at,
          tenants!inner(
            id,
            name,
            created_at
          )
        `,
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<MembershipRow>();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to resolve tenant membership: ${error.message}`,
      );
    }

    if (!data?.tenants) {
      return null;
    }

    return Array.isArray(data.tenants) ? data.tenants[0] ?? null : data.tenants;
  }

  private async fetchTenantProducts(tenantId: string, limit?: number) {
    const supabase = this.databaseService.getClient();
    let query = supabase
      .from('products')
      .select(
        `
          id,
          title,
          slug,
          price,
          status,
          ai_generated_metadata,
          created_at,
          published_at,
          product_media(file_url, media_type, is_primary)
        `,
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to fetch tenant products: ${error.message}`,
      );
    }

    return data ?? [];
  }

  private isTokenValid(tokenExpiresAt: string | null): boolean {
    if (!tokenExpiresAt) {
      return true;
    }

    const expiresAtMs = new Date(tokenExpiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) {
      return false;
    }

    return expiresAtMs > Date.now();
  }

  private mapExecutionRow(row: AutomationExecutionRow) {
    return {
      id: row.id,
      workflow_name: row.workflow_name,
      external_execution_id: row.external_execution_id,
      status: row.status,
      node_name: row.node_name,
      error_reason: row.error_reason,
      meta: row.meta,
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapFailedItemRow(row: FailedItemRow) {
    const retryContext = this.extractRetryContext(row.payload, row.tenant_id);
    return {
      id: row.id,
      workflow_name: row.workflow_name,
      node_name: row.node_name,
      error_reason: row.error_reason,
      retry_count: row.retry_count,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_retry_at: row.last_retry_at,
      last_retry_job_id: row.last_retry_job_id,
      payload: row.payload ?? {},
      retryable: Boolean(retryContext),
      retry_context: retryContext,
    };
  }

  private parseListLimit(raw: string | undefined, fallback: number, max: number): number {
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(parsed, max);
  }

  private parseOptionalIsoCursor(raw: string | undefined): string | null {
    if (!raw) {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const ms = new Date(trimmed).getTime();
    if (Number.isNaN(ms)) {
      throw new BadRequestException('cursor must be a valid ISO datetime string');
    }
    return new Date(ms).toISOString();
  }

  private extractRetryContext(
    payload: Record<string, unknown> | null,
    tenantId: string,
  ): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const raw = payload.retry_context;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }

    const retryContext = raw as Record<string, unknown>;
    if (retryContext.tenant_id !== tenantId) {
      return null;
    }
    if (typeof retryContext.platform_post_id !== 'string') {
      return null;
    }

    return retryContext;
  }

  private async logAuditEvent(
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    const supabase = this.databaseService.getClient();
    await supabase.from('audit_log').insert({
      tenant_id: tenantId,
      event_type: eventType,
      payload,
    });
  }
}
