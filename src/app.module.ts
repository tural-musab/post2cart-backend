import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CryptoModule } from './crypto/crypto.module';
import { TenantsModule } from './tenants/tenants.module';
import { CronModule } from './cron/cron.module';
import { N8nIntegrationModule } from './n8n-integration/n8n-integration.module';
import { MediaModule } from './media/media.module';
import { ProductsModule } from './products/products.module';
import { DatabaseModule } from './database/database.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { AppClientModule } from './app-client/app-client.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    CryptoModule,
    TenantsModule,
    CronModule,
    N8nIntegrationModule,
    MediaModule,
    ProductsModule,
    DatabaseModule,
    AuthModule,
    AppClientModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
