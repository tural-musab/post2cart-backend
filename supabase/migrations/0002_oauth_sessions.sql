ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS token_source TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS oauth_scopes TEXT[];

UPDATE social_accounts
SET token_source = 'manual'
WHERE token_source IS NULL;

CREATE TABLE IF NOT EXISTS oauth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  state_nonce TEXT NOT NULL,
  state_expires_at TIMESTAMPTZ NOT NULL,
  encrypted_access_token TEXT,
  token_expires_at TIMESTAMPTZ,
  candidates JSONB,
  selected_platform_account_id TEXT,
  error_code TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_user_status
  ON oauth_sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_tenant_provider
  ON oauth_sessions(tenant_id, provider);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_state_expiry
  ON oauth_sessions(state_expires_at);

ALTER TABLE oauth_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'oauth_sessions'
      AND policyname = 'Users can access own oauth sessions'
  ) THEN
    CREATE POLICY "Users can access own oauth sessions"
      ON oauth_sessions
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;
