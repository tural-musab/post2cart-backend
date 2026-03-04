import { Module } from '@nestjs/common';
import { SyncStateController } from './sync-state.controller';
import { SyncStateService } from './sync-state.service';
import { N8nWebhookController } from './n8n-webhook.controller';

@Module({
    controllers: [SyncStateController, N8nWebhookController],
    providers: [SyncStateService],
    exports: [SyncStateService]
})
export class N8nIntegrationModule { }
