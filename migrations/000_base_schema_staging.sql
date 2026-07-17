-- ============================================================================
-- Migration 000: VAI IA base schema (STAGING reconstruction)
--
-- Reconstructed from the application code's actual table usage (every
-- supabase.from("...") read/write in index.js and auth/supabase.js).
-- Columns are DERIVED FROM VERIFIED USAGE — not invented.
--
-- Structure + security only. NO production data. Apply in a fresh STAGING
-- project BEFORE 001_business_assistant.sql.
--
-- Sources (file:function → columns):
--   tenants           ← /admin/api/tenant/save upsert + mapTenantRow
--   appointments      ← saveAppointments upsert + mapApptRow
--   pending_bookings  ← savePending upsert
--   chat_sessions     ← saveSession upsert + mapSessionRow
--   conversation_messages ← logConversation insert
--   sms_messages      ← logSms insert
--   reminders         ← scheduleReminder insert + reminders loop update
--   client_users      ← upsertClientUser + findClientByEmail
--   admin_users       ← findAdminByEmail
-- ============================================================================

-- ── tenants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  slug          text PRIMARY KEY,
  name          text,
  system_prompt text,
  vars          jsonb NOT NULL DEFAULT '{}'::jsonb,
  faq           jsonb NOT NULL DEFAULT '[]'::jsonb,
  fallback      text,
  twilio_number text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenants_twilio ON tenants (twilio_number);

-- ── appointments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id            text PRIMARY KEY,
  tenant_slug   text NOT NULL,
  title         text,
  service       text,
  customer_name text,
  client_name   text,
  start_at      timestamptz,
  end_at        timestamptz,
  email         text,
  phone         text,
  notes         text,
  confirmed     boolean NOT NULL DEFAULT true,
  cancel_token  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appointments_tenant_start
  ON appointments (tenant_slug, start_at);

-- ── pending_bookings ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_bookings (
  token         text PRIMARY KEY,
  tenant_slug   text NOT NULL,
  expires_at    timestamptz,
  lang          text,
  appt_id       text,
  customer_name text,
  service       text,
  email         text,
  phone         text,
  notes         text,
  start_at      timestamptz,
  end_at        timestamptz,
  cancel_token  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_tenant ON pending_bookings (tenant_slug);

-- ── chat_sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id           text PRIMARY KEY,
  tenant_slug          text NOT NULL,
  channel              text,
  lang                 text,
  state                text DEFAULT 'IDLE',
  draft                jsonb DEFAULT '{}'::jsonb,
  history              jsonb DEFAULT '[]'::jsonb,
  cancel_flow          jsonb,
  last_draft           jsonb,
  last_suggestions     jsonb,
  last_suggestion_tz   text,
  pending_confirmation boolean DEFAULT false,
  pending_email        text,
  price_ask_count      integer DEFAULT 0,
  repeat_flag          boolean DEFAULT false,
  last_activity_at     timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON chat_sessions (tenant_slug);

-- ── conversation_messages ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   text,
  tenant_slug  text NOT NULL,
  channel      text,
  role         text,
  content      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_msg_tenant ON conversation_messages (tenant_slug, created_at DESC);

-- ── sms_messages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug  text NOT NULL,
  from_number  text,
  to_number    text,
  direction    text CHECK (direction IN ('inbound','outbound')),
  content      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_tenant ON sms_messages (tenant_slug, created_at DESC);

-- ── reminders ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug    text,
  appointment_id text,
  to_email       text,
  subject        text,
  body_text      text,
  body_html      text,
  fire_at        timestamptz,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  sent_at        timestamptz,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders (status, fire_at);

-- ── client_users (panel login) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug   text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── admin_users ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text DEFAULT 'admin',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── RLS: deny-all (backend uses the service role, which bypasses RLS) ────────
ALTER TABLE tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_bookings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users           ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- ROLLBACK (staging only):
-- DROP TABLE IF EXISTS admin_users, client_users, reminders, sms_messages,
--   conversation_messages, chat_sessions, pending_bookings, appointments, tenants CASCADE;
-- ============================================================================
