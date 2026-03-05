import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SupabaseJwtGuard } from './guards/supabase-jwt.guard';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [SupabaseJwtGuard],
  exports: [SupabaseJwtGuard],
})
export class AuthModule {}
