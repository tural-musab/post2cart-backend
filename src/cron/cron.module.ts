import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../database/database.module';
import { CryptoModule } from '../crypto/crypto.module';
import { CronService } from './cron.service';

@Module({
  imports: [ScheduleModule.forRoot(), DatabaseModule, CryptoModule],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
