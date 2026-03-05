import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

type ExecutionStatus = 'started' | 'success' | 'failed';

interface ExecutionEventPayload {
  tenantId: string;
  workflowName: string;
  externalExecutionId: string;
  status: ExecutionStatus;
  nodeName?: string;
  errorReason?: string;
  startedAt?: string;
  finishedAt?: string;
  meta?: Record<string, unknown>;
}

interface CompleteRetryJobPayload {
  jobId: string;
  success: boolean;
  errorReason?: string;
}

interface RetryJobRow {
  id: string;
  tenant_id: string;
  failed_item_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  retry_context: Record<string, unknown>;
  attempt_number: number;
  created_at: string;
  updated_at: string;
}

interface FailedItemForRetry {
  id: string;
  tenant_id: string;
  status: string;
  retry_count: number;
  error_reason: string;
}

@Injectable()
export class AutomationInternalService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async recordExecutionEvent(payload: ExecutionEventPayload) {
    const supabase = this.databaseService.getClient();
    const nowIso = new Date().toISOString();

    const normalizedStatus = payload.status;
    if (!['started', 'success', 'failed'].includes(normalizedStatus)) {
      throw new BadRequestException('status must be one of started|success|failed');
    }

    const startedAt = this.normalizeDate(payload.startedAt) ?? nowIso;
    const finishedAt =
      normalizedStatus === 'started'
        ? null
        : this.normalizeDate(payload.finishedAt) ?? nowIso;

    const { data: existing, error: existingError } = await supabase
      .from('automation_executions')
      .select(
        'id, tenant_id, workflow_name, external_execution_id, status, node_name, error_reason, meta, started_at, finished_at, created_at, updated_at',
      )
      .eq('tenant_id', payload.tenantId)
      .eq('workflow_name', payload.workflowName)
      .eq('external_execution_id', payload.externalExecutionId)
      .maybeSingle();

    if (existingError) {
      throw new InternalServerErrorException(
        `Failed to check existing execution event: ${existingError.message}`,
      );
    }

    if (!existing) {
      const { data: inserted, error: insertError } = await supabase
        .from('automation_executions')
        .insert({
          tenant_id: payload.tenantId,
          workflow_name: payload.workflowName,
          external_execution_id: payload.externalExecutionId,
          status: normalizedStatus,
          node_name: payload.nodeName ?? null,
          error_reason: payload.errorReason ?? null,
          meta: payload.meta ?? {},
          started_at: startedAt,
          finished_at: finishedAt,
          updated_at: nowIso,
        })
        .select(
          'id, tenant_id, workflow_name, external_execution_id, status, node_name, error_reason, meta, started_at, finished_at, created_at, updated_at',
        )
        .single();

      if (insertError || !inserted) {
        throw new InternalServerErrorException(
          `Failed to insert execution event: ${insertError?.message ?? 'unknown error'}`,
        );
      }

      return {
        status: 'recorded',
        execution: inserted,
      };
    }

    const updatePayload: Record<string, unknown> = {
      status: normalizedStatus,
      node_name: payload.nodeName ?? existing.node_name,
      error_reason: payload.errorReason ?? (normalizedStatus === 'success' ? null : existing.error_reason),
      meta: payload.meta ?? existing.meta,
      updated_at: nowIso,
    };

    if (normalizedStatus === 'started' && !existing.started_at) {
      updatePayload.started_at = startedAt;
    }
    if (finishedAt) {
      updatePayload.finished_at = finishedAt;
    }

    const { data: updated, error: updateError } = await supabase
      .from('automation_executions')
      .update(updatePayload)
      .eq('id', existing.id)
      .select(
        'id, tenant_id, workflow_name, external_execution_id, status, node_name, error_reason, meta, started_at, finished_at, created_at, updated_at',
      )
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException(
        `Failed to update execution event: ${updateError?.message ?? 'unknown error'}`,
      );
    }

    return {
      status: 'recorded',
      execution: updated,
    };
  }

  async claimRetryJobs(rawLimit?: number, worker?: string) {
    const configuredLimit = Number(
      this.configService.get<string>('AUTOMATION_RETRY_CLAIM_LIMIT') ?? '20',
    );
    const fallbackLimit =
      Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 20;
    const limit =
      Number.isInteger(rawLimit) && (rawLimit as number) > 0
        ? Math.min(rawLimit as number, 100)
        : fallbackLimit;

    const supabase = this.databaseService.getClient();
    const { data, error } = await supabase.rpc('claim_automation_retry_jobs', {
      p_limit: limit,
      p_worker: worker?.trim() || 'n8n',
    });

    if (error) {
      throw new InternalServerErrorException(
        `Failed to claim retry jobs: ${error.message}`,
      );
    }

    return {
      status: 'claimed',
      count: data?.length ?? 0,
      items: (data ?? []).map((row: RetryJobRow) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        failed_item_id: row.failed_item_id,
        retry_context: row.retry_context,
        attempt_number: row.attempt_number,
        claimed_at: row.updated_at,
      })),
    };
  }

  async completeRetryJob(payload: CompleteRetryJobPayload) {
    const supabase = this.databaseService.getClient();
    const nowIso = new Date().toISOString();

    const { data: retryJob, error: retryJobError } = await supabase
      .from('automation_retry_jobs')
      .select(
        'id, tenant_id, failed_item_id, status, retry_context, attempt_number, created_at, updated_at',
      )
      .eq('id', payload.jobId)
      .maybeSingle<RetryJobRow>();

    if (retryJobError || !retryJob) {
      throw new NotFoundException('Retry job not found');
    }

    if (!['queued', 'processing'].includes(retryJob.status)) {
      throw new BadRequestException('Retry job is not claimable for completion');
    }

    const { data: failedItem, error: failedItemError } = await supabase
      .from('failed_items')
      .select('id, tenant_id, status, retry_count, error_reason')
      .eq('id', retryJob.failed_item_id)
      .eq('tenant_id', retryJob.tenant_id)
      .maybeSingle<FailedItemForRetry>();

    if (failedItemError || !failedItem) {
      throw new NotFoundException('Related failed item not found');
    }

    const nextJobStatus = payload.success ? 'completed' : 'failed';
    const { error: updateJobError } = await supabase
      .from('automation_retry_jobs')
      .update({
        status: nextJobStatus,
        error_reason: payload.success ? null : payload.errorReason ?? 'retry_execution_failed',
        finished_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', retryJob.id);

    if (updateJobError) {
      throw new InternalServerErrorException(
        `Failed to update retry job status: ${updateJobError.message}`,
      );
    }

    const nextRetryCount = payload.success
      ? (failedItem.retry_count ?? 0) + 1
      : failedItem.retry_count ?? 0;

    const { error: updateFailedItemError } = await supabase
      .from('failed_items')
      .update({
        status: payload.success ? 'resolved' : 'pending',
        retry_count: nextRetryCount,
        error_reason: payload.success
          ? failedItem.error_reason
          : payload.errorReason ?? failedItem.error_reason,
        updated_at: nowIso,
      })
      .eq('id', failedItem.id)
      .eq('tenant_id', failedItem.tenant_id);

    if (updateFailedItemError) {
      throw new InternalServerErrorException(
        `Failed to update failed item after retry completion: ${updateFailedItemError.message}`,
      );
    }

    await supabase.from('audit_log').insert({
      tenant_id: failedItem.tenant_id,
      event_type: payload.success ? 'automation_retry_completed' : 'automation_retry_failed',
      payload: {
        retry_job_id: retryJob.id,
        failed_item_id: failedItem.id,
        attempt_number: retryJob.attempt_number,
        error_reason: payload.success ? null : payload.errorReason ?? null,
      },
    });

    return {
      status: 'completed',
      retry_job_id: retryJob.id,
      failed_item_id: failedItem.id,
      outcome: payload.success ? 'success' : 'failed',
      completed_at: nowIso,
    };
  }

  private normalizeDate(value?: string): string | null {
    if (!value) {
      return null;
    }
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) {
      throw new BadRequestException('Invalid datetime value');
    }
    return new Date(ms).toISOString();
  }
}
