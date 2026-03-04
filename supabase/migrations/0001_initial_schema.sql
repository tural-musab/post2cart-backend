/**
 * 1. TENANT VE MEMBERSHIP (KAYNAK MERKEZİ)
 */
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, user_id)
);
CREATE INDEX idx_memberships_user_tenant ON memberships(user_id, tenant_id);

/**
 * 2. SOCIAL ACCOUNTS & SYNC STATE
 */
CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'instagram', 'tiktok', 'facebook'
  platform_account_id TEXT NOT NULL,
  platform_username TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active', -- 'active', 'expired', 'revoked'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, platform_account_id, tenant_id)
);
CREATE INDEX idx_social_accounts_tenant ON social_accounts(tenant_id);

CREATE TABLE sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  social_account_id UUID NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  last_cursor_id TEXT,
  last_synced_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(social_account_id)
);

/**
 * 3. SOCIAL POSTS VE PRODUCTS (CORE DATABASES)
 */
CREATE TABLE social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_post_id TEXT NOT NULL,
  content JSONB NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, platform_post_id, tenant_id)
);
CREATE INDEX idx_social_posts_tenant_unprocessed ON social_posts(tenant_id) WHERE processed = FALSE;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_post_id UUID REFERENCES social_posts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  price DECIMAL(10, 2) DEFAULT 0.00,
  ai_generated_metadata JSONB,
  status TEXT DEFAULT 'draft', -- 'draft', 'published', 'archived'
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(slug, tenant_id)
);
CREATE INDEX idx_products_tenant_status ON products(tenant_id, status);

CREATE TABLE product_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  media_type TEXT NOT NULL, -- 'image', 'video'
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_product_media_product ON product_media(product_id);

/**
 * 4. SYSTEM TABLES (DLQ & AUDIT)
 */
CREATE TABLE failed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  node_name TEXT,
  payload JSONB,
  error_reason TEXT NOT NULL,
  retry_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- 'pending', 'resolved', 'ignored'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_failed_items_tenant_status ON failed_items(tenant_id, status);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_log_tenant_event ON audit_log(tenant_id, event_type);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

/**
 * RLS Aktifleştirme
 */
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

/**
 * Helper Function (Performans Optimizasyonu İçin)
 */
CREATE OR REPLACE FUNCTION user_belongs_to_tenant(target_tenant_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE tenant_id = target_tenant_id
      AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER;

/**
 * RLS Policies (Tüm Tablolar)
 */
CREATE POLICY "Users can access tenant social_accounts" ON social_accounts FOR ALL USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can access tenant sync_state" ON sync_state FOR ALL USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can access tenant social_posts" ON social_posts FOR ALL USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can access tenant products" ON products FOR ALL USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can access tenant product_media" ON product_media FOR ALL USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can access tenant failed_items" ON failed_items FOR ALL USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can view tenant audit_log" ON audit_log FOR SELECT USING (user_belongs_to_tenant(tenant_id));
CREATE POLICY "Users can insert tenant audit_log" ON audit_log FOR INSERT WITH CHECK (user_belongs_to_tenant(tenant_id));

/**
 * Audit Log Retention (pg_cron)
 */
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION delete_old_audit_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

SELECT cron.schedule(
  'cleanup-old-audit-logs', 
  '0 3 * * *', 
  $$SELECT delete_old_audit_logs()$$
);
