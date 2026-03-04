import { Controller, Get, Param, Post, Body, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { SyncStateService } from './sync-state.service';

/**
 * Controller strictly dedicated to serving n8n workflow requests.
 * n8n polls this endpoint to know which tenants it needs to process.
 */
@Controller('n8n/sync-state')
export class SyncStateController {
    constructor(private readonly syncStateService: SyncStateService) { }

    /**
     * Called by the n8n Master Workflow.
     * Fetches a list of active tenants that need social post polling.
     */
    @Get('active')
    async getActiveSyncStates() {
        try {
            return await this.syncStateService.getActiveSyncStates();
        } catch (error) {
            throw new HttpException('Failed to fetch active sync states', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    /**
     * Called by n8n after a successful poll to update the pagination cursor
     */
    @Post('update-cursor')
    async updateCursor(
        @Body('sync_state_id') syncStateId: string,
        @Body('last_cursor_id') lastCursorId: string
    ) {
        if (!syncStateId || !lastCursorId) {
            throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
        }
        return this.syncStateService.updateCursor(syncStateId, lastCursorId);
    }
}
