-- ============================================================================
-- Migration 001: VAI Business Assistant
-- Creates the tables used by the private in-panel Business Assistant.
--
-- HOW TO APPLY: run this file once in the Supabase SQL Editor.
-- HOW TO REVERT: run the DROP statements at the bottom (commented out).
--
-- IMPORTANT: the backend uses SUPABASE_SERVICE_KEY (service role), which
-- BYPASSES RLS. RLS policies below are defense-in-depth for any future
-- anon/authenticated access. The backend MUST always filter by tenant_slug —
-- this is enforced in code (business-assistant.js).
-- ============================================================================

-- ── 1. Conversations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_assistant_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug   text NOT NULL,
  user_email    text NOT NULL,
  title         text NOT NULL DEFAULT 'New conversation',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  summary       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ba_conv_tenant
  ON business_assistant_conversations (tenant_slug, last_message_at DESC);

-- ── 2. Messages ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_assistant_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES business_assistant_conversations(id) ON DELETE CASCADE,
  tenant_slug     text NOT NULL,
  user_email      text,
  role            text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         text NOT NULL DEFAULT '',
  tool_name       text,
  tool_result_summary text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ba_msg_conv
  ON business_assistant_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ba_msg_tenant
  ON business_assistant_messages (tenant_slug, created_at DESC);

-- ── 3. Availability exceptions (blocks) ─────────────────────────────────────
-- Single source of truth for "the business is NOT available at this time".
-- The public receptionist checks this table before offering/booking slots.
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug     text NOT NULL,
  staff_id        text,                 -- null = whole business
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  exception_type  text NOT NULL DEFAULT 'block' CHECK (exception_type IN ('block','full_day','multi_day')),
  internal_reason text,                 -- NEVER sent to customers
  public_reason   text,                 -- customer-safe wording (optional)
  scope           text NOT NULL DEFAULT 'one_time' CHECK (scope IN ('one_time','recurring')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_interval CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_avail_exc_tenant_time
  ON availability_exceptions (tenant_slug, status, starts_at, ends_at);

-- ── 4. Pending actions (confirm-before-execute) ─────────────────────────────
CREATE TABLE IF NOT EXISTS assistant_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug     text NOT NULL,
  user_email      text NOT NULL,
  conversation_id uuid,
  action_type     text NOT NULL,
  action_payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
  impact_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_level      text NOT NULL DEFAULT 'CONFIRM' CHECK (risk_level IN ('READ','PREPARE','CONFIRM','STRONG_CONFIRM')),
  status          text NOT NULL DEFAULT 'pending_confirmation'
                  CHECK (status IN ('pending_confirmation','confirmed','executing','completed','failed','cancelled','expired')),
  idempotency_key text NOT NULL,
  expires_at      timestamptz NOT NULL,
  confirmed_at    timestamptz,
  executed_at     timestamptz,
  cancelled_at    timestamptz,
  failed_at       timestamptz,
  error_code      text,
  result_summary  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ba_idempotency UNIQUE (tenant_slug, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ba_actions_tenant
  ON assistant_pending_actions (tenant_slug, status, created_at DESC);

-- ── 5. Action logs (audit trail) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assistant_action_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug   text NOT NULL,
  user_email    text,
  action_id     uuid,
  action_type   text,
  event_type    text NOT NULL,   -- created | confirmed | executed | failed | cancelled | expired
  input_summary text,
  result_summary text,
  status        text,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ba_logs_tenant
  ON assistant_action_logs (tenant_slug, created_at DESC);

-- ── 6. Atomic confirm function ──────────────────────────────────────────────
-- Transitions pending_confirmation → confirmed atomically. Returns the row
-- only if the transition happened (prevents double-confirm race).
--
-- SECURITY NOTES:
--  * SECURITY INVOKER (default, made explicit): runs with the caller's
--    privileges — only the backend's service role can reach these tables
--    (RLS is deny-all for anon/authenticated).
--  * search_path is pinned and all objects are schema-qualified, so the
--    function cannot be hijacked by objects in another schema.
--  * p_tenant is NEVER supplied by an end user: the backend passes the
--    tenant slug resolved from the authenticated JWT (req.client.slug).
CREATE OR REPLACE FUNCTION public.ba_confirm_action(p_id uuid, p_tenant text)
RETURNS SETOF public.assistant_pending_actions
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.assistant_pending_actions
     SET status = 'confirmed', confirmed_at = now(), updated_at = now()
   WHERE id = p_id
     AND tenant_slug = p_tenant
     AND status = 'pending_confirmation'
     AND expires_at > now()
  RETURNING *;
$$;

-- ── 7. RLS (defense in depth; service role bypasses this) ───────────────────
ALTER TABLE business_assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_assistant_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_exceptions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_pending_actions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_action_logs           ENABLE ROW LEVEL SECURITY;

-- Deny-all default: no policies created for anon/authenticated.
-- Only the service role (backend) can access these tables.

-- ============================================================================
-- ROLLBACK (run manually to revert):
-- DROP FUNCTION IF EXISTS ba_confirm_action(uuid, text);
-- DROP TABLE IF EXISTS assistant_action_logs;
-- DROP TABLE IF EXISTS assistant_pending_actions;
-- DROP TABLE IF EXISTS availability_exceptions;
-- DROP TABLE IF EXISTS business_assistant_messages;
-- DROP TABLE IF EXISTS business_assistant_conversations;
-- ============================================================================
