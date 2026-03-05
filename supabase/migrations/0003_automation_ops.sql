CREATE TABLE IF NOT EXISTS automation_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  external_execution_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  node_name TEXT,
  error_reason TEXT,
  meta JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, workflow_name, external_execution_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_executions_tenant_created
  ON automation_executions(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_executions_tenant_status
  ON automation_executions(tenant_id, status);

CREATE TABLE IF NOT EXISTS automation_retry_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  failed_item_id UUID NOT NULL REFERENCES failed_items(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  retry_context JSONB NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  claimed_by TEXT,
  error_reason TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_retry_jobs_tenant_created
  ON automation_retry_jobs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_retry_jobs_status_created
  ON automation_retry_jobs(status, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_retry_jobs_failed_item_active
  ON automation_retry_jobs(failed_item_id)
  WHERE status IN ('queued', 'processing');

ALTER TABLE failed_items
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_retry_job_id UUID REFERENCES automation_retry_jobs(id) ON DELETE SET NULL;

ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_retry_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'automation_executions'
      AND policyname = 'Users can access tenant automation_executions'
  ) THEN
    CREATE POLICY "Users can access tenant automation_executions"
      ON automation_executions
      FOR ALL
      USING (user_belongs_to_tenant(tenant_id))
      WITH CHECK (user_belongs_to_tenant(tenant_id));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'automation_retry_jobs'
      AND policyname = 'Users can access tenant automation_retry_jobs'
  ) THEN
    CREATE POLICY "Users can access tenant automation_retry_jobs"
      ON automation_retry_jobs
      FOR ALL
      USING (user_belongs_to_tenant(tenant_id))
      WITH CHECK (user_belongs_to_tenant(tenant_id));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION claim_automation_retry_jobs(
  p_limit INTEGER DEFAULT 20,
  p_worker TEXT DEFAULT 'n8n'
)
RETURNS SETOF automation_retry_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM automation_retry_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT GREATEST(COALESCE(p_limit, 20), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE automation_retry_jobs AS jobs
  SET status = 'processing',
      claimed_by = p_worker,
      started_at = NOW(),
      updated_at = NOW()
  FROM claimable
  WHERE jobs.id = claimable.id
  RETURNING jobs.*;
END;
$$;
