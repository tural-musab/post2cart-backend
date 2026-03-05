import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { DatabaseModule } from '../database/database.module';
import { AppClientController } from './app-client.controller';
import { AppClientService } from './app-client.service';

@Module({
  imports: [AuthModule, DatabaseModule, CryptoModule],
  controllers: [AppClientController],
  providers: [AppClientService],
  exports: [AppClientService],
})
export class AppClientModule {}
