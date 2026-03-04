import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class DatabaseService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseService.name);
    private supabaseClient: SupabaseClient;

    constructor(private readonly configService: ConfigService) { }

    onModuleInit() {
        const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
        const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

        if (!supabaseUrl || !supabaseKey) {
            this.logger.warn('Supabase configuration missing in .env!');
            return;
        }

        try {
            // This creates a Service Role client but we MUST enforce RLS manually or via claims later.
            // Given the architecture, all insert checks MUST validate the TenantID first.
            this.supabaseClient = createClient(supabaseUrl, supabaseKey, {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false,
                },
            });
        } catch (error: any) {
            this.logger.warn(`Supabase client initialization skipped: ${error.message}`);
        }
    }

    getClient(): SupabaseClient {
        return this.supabaseClient;
    }
}
