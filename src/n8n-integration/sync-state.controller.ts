import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SyncStateService } from './sync-state.service';
import { InternalServiceTokenGuard } from '../common/guards/internal-service-token.guard';

@Controller('n8n/sync-state')
@UseGuards(InternalServiceTokenGuard)
export class SyncStateController {
  constructor(private readonly syncStateService: SyncStateService) {}

  @Get('active')
  async getActiveSyncStates() {
    try {
      return await this.syncStateService.getActiveSyncStates();
    } catch {
      throw new HttpException(
        'Failed to fetch active sync states',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('update-cursor')
  async updateCursor(
    @Body('sync_state_id') syncStateId: string,
    @Body('last_cursor_id') lastCursorId: string,
  ) {
    if (!syncStateId || !lastCursorId) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }

    return this.syncStateService.updateCursor(syncStateId, lastCursorId);
  }
}
