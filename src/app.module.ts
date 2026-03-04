import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CryptoModule } from './crypto/crypto.module';
import { TenantsModule } from './tenants/tenants.module';
import { CronModule } from './cron/cron.module';

@Module({
  imports: [CryptoModule, TenantsModule, CronModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
