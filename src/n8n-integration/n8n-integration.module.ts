import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CryptoModule } from '../crypto/crypto.module';
import { InternalServiceTokenGuard } from '../common/guards/internal-service-token.guard';
import { SyncStateController } from './sync-state.controller';
import { SyncStateService } from './sync-state.service';
import { N8nWebhookController } from './n8n-webhook.controller';
import { N8nWebhookService } from './n8n-webhook.service';
import { SocialFeedbackService } from './social-feedback.service';
import { SocialFeedbackController } from './social-feedback.controller';
import { AutomationInternalController } from './automation-internal.controller';
import { AutomationInternalService } from './automation-internal.service';

@Module({
  imports: [DatabaseModule, CryptoModule],
  controllers: [
    SyncStateController,
    N8nWebhookController,
    SocialFeedbackController,
    AutomationInternalController,
  ],
  providers: [
    SyncStateService,
    N8nWebhookService,
    SocialFeedbackService,
    AutomationInternalService,
    InternalServiceTokenGuard,
  ],
  exports: [
    SyncStateService,
    N8nWebhookService,
    SocialFeedbackService,
    AutomationInternalService,
  ],
})
export class N8nIntegrationModule {}
