import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalServiceTokenGuard } from '../common/guards/internal-service-token.guard';
import { AutomationInternalService } from './automation-internal.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('n8n')
@UseGuards(InternalServiceTokenGuard)
export class AutomationInternalController {
  constructor(
    private readonly automationInternalService: AutomationInternalService,
  ) {}

  @Post('automation/executions/event')
  async executionEvent(
    @Body('tenant_id') tenantId: string,
    @Body('workflow_name') workflowName: string,
    @Body('external_execution_id') externalExecutionId: string,
    @Body('status') status: 'started' | 'success' | 'failed',
    @Body('node_name') nodeName?: string,
    @Body('error_reason') errorReason?: string,
    @Body('started_at') startedAt?: string,
    @Body('finished_at') finishedAt?: string,
    @Body('meta') meta?: Record<string, unknown>,
  ) {
    if (!tenantId || !UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('tenant_id must be a valid UUID');
    }
    if (!workflowName?.trim()) {
      throw new BadRequestException('workflow_name is required');
    }
    if (!externalExecutionId?.trim()) {
      throw new BadRequestException('external_execution_id is required');
    }

    return this.automationInternalService.recordExecutionEvent({
      tenantId,
      workflowName: workflowName.trim(),
      externalExecutionId: externalExecutionId.trim(),
      status,
      nodeName: nodeName?.trim() || undefined,
      errorReason: errorReason?.trim() || undefined,
      startedAt: startedAt?.trim() || undefined,
      finishedAt: finishedAt?.trim() || undefined,
      meta,
    });
  }

  @Post('retry-jobs/claim')
  async claimRetryJobs(
    @Body('limit') limit?: number,
    @Body('worker') worker?: string,
  ) {
    return this.automationInternalService.claimRetryJobs(limit, worker);
  }

  @Post('retry-jobs/complete')
  async completeRetryJob(
    @Body('job_id') jobId: string,
    @Body('success') success: boolean,
    @Body('error_reason') errorReason?: string,
  ) {
    if (!jobId || !UUID_REGEX.test(jobId)) {
      throw new BadRequestException('job_id must be a valid UUID');
    }
    if (typeof success !== 'boolean') {
      throw new BadRequestException('success must be a boolean');
    }

    return this.automationInternalService.completeRetryJob({
      jobId,
      success,
      errorReason: errorReason?.trim() || undefined,
    });
  }
}
