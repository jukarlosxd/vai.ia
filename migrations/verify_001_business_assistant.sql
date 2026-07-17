-- ============================================================================
-- Verification script for migration 001_business_assistant.sql
-- Run in the Supabase SQL Editor AFTER applying the migration.
-- Every query must return the expected value; read-only except section 4,
-- which inserts + cleans up one test row inside a transaction.
-- ============================================================================

-- 1. All five tables exist (expect: 5 rows)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN (
  'business_assistant_conversations',
  'business_assistant_messages',
  'availability_exceptions',
  'assistant_pending_actions',
  'assistant_action_logs'
) ORDER BY table_name;

-- 2. Columns the backend writes actually exist (expect: 0 rows = no missing)
WITH required(tbl, col) AS (VALUES
  ('business_assistant_conversations','id'),('business_assistant_conversations','tenant_slug'),
  ('business_assistant_conversations','user_email'),('business_assistant_conversations','title'),
  ('business_assistant_conversations','status'),('business_assistant_conversations','last_message_at'),
  ('business_assistant_messages','conversation_id'),('business_assistant_messages','tenant_slug'),
  ('business_assistant_messages','role'),('business_assistant_messages','content'),
  ('availability_exceptions','tenant_slug'),('availability_exceptions','starts_at'),
  ('availability_exceptions','ends_at'),('availability_exceptions','exception_type'),
  ('availability_exceptions','internal_reason'),('availability_exceptions','public_reason'),
  ('availability_exceptions','status'),('availability_exceptions','created_by'),
  ('assistant_pending_actions','tenant_slug'),('assistant_pending_actions','user_email'),
  ('assistant_pending_actions','action_type'),('assistant_pending_actions','action_payload'),
  ('assistant_pending_actions','impact_summary'),('assistant_pending_actions','risk_level'),
  ('assistant_pending_actions','status'),('assistant_pending_actions','idempotency_key'),
  ('assistant_pending_actions','expires_at'),('assistant_pending_actions','result_summary'),
  ('assistant_action_logs','tenant_slug'),('assistant_action_logs','event_type')
)
SELECT r.tbl, r.col AS missing_column FROM required r
LEFT JOIN information_schema.columns c
  ON c.table_schema='public' AND c.table_name=r.tbl AND c.column_name=r.col
WHERE c.column_name IS NULL;

-- 3. RLS enabled on all five tables (expect: 5 rows, all rowsecurity = true)
SELECT relname, relrowsecurity FROM pg_class
WHERE relname IN ('business_assistant_conversations','business_assistant_messages',
  'availability_exceptions','assistant_pending_actions','assistant_action_logs');

-- 4. ba_confirm_action: atomic transition + expiry + tenant guard
BEGIN;
  INSERT INTO public.assistant_pending_actions
    (id, tenant_slug, user_email, action_type, action_payload, risk_level,
     status, idempotency_key, expires_at)
  VALUES
    ('11111111-1111-4111-8111-111111111111', '__verify__', 'v@test', 'cancel_appointment',
     '{}'::jsonb, 'CONFIRM', 'pending_confirmation', 'verify-key-1', now() + interval '5 minutes');

  -- 4a. wrong tenant → 0 rows (tenant guard works)
  SELECT count(*) AS wrong_tenant_should_be_0
  FROM public.ba_confirm_action('11111111-1111-4111-8111-111111111111', 'other-tenant');

  -- 4b. right tenant → 1 row (confirm succeeds)
  SELECT count(*) AS right_tenant_should_be_1
  FROM public.ba_confirm_action('11111111-1111-4111-8111-111111111111', '__verify__');

  -- 4c. second confirm → 0 rows (double-confirm blocked)
  SELECT count(*) AS double_confirm_should_be_0
  FROM public.ba_confirm_action('11111111-1111-4111-8111-111111111111', '__verify__');
ROLLBACK;  -- leaves no test data behind

-- 5. Expired action cannot be confirmed
BEGIN;
  INSERT INTO public.assistant_pending_actions
    (id, tenant_slug, user_email, action_type, action_payload, risk_level,
     status, idempotency_key, expires_at)
  VALUES
    ('22222222-2222-4222-8222-222222222222', '__verify__', 'v@test', 'cancel_appointment',
     '{}'::jsonb, 'CONFIRM', 'pending_confirmation', 'verify-key-2', now() - interval '1 minute');

  SELECT count(*) AS expired_should_be_0
  FROM public.ba_confirm_action('22222222-2222-4222-8222-222222222222', '__verify__');
ROLLBACK;
