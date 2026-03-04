import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CryptoModule } from './crypto/crypto.module';
import { TenantsModule } from './tenants/tenants.module';
import { CronModule } from './cron/cron.module';
import { N8nIntegrationModule } from './n8n-integration/n8n-integration.module';
import { MediaModule } from './media/media.module';

@Module({
  imports: [CryptoModule, TenantsModule, CronModule, N8nIntegrationModule, MediaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
