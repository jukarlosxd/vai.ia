-- ============================================================================
-- Migration 003: Twilio SMS integration (staging)
--
-- Adds the storage for a manageable, per-tenant Twilio SMS integration so new
-- clients can be onboarded from Admin → Apps → Twilio WITHOUT editing code.
--
-- SECURITY:
--   * Secrets (Auth Token, API Key Secret) are stored ONLY as AES-256-GCM
--     ciphertext bundles produced by auth/integration-crypto.js. The master key
--     lives in INTEGRATIONS_ENCRYPTION_KEY (env only) — never in this database.
--   * RLS is deny-all on every table. The backend uses the Supabase service role
--     (which bypasses RLS) and ALWAYS scopes queries by tenant in code. No anon /
--     authenticated / client access to any of these tables.
--
-- REUSE: message bodies already logged to sms_messages remain; twilio_message_logs
-- adds delivery-status tracking (SID, status, error_code) needed for callbacks.
--
-- HOW TO APPLY: run once in the Supabase SQL Editor (staging project only).
-- ============================================================================

-- ── 1. app_integrations — generic per-provider/scope/env integration record ──
CREATE TABLE IF NOT EXISTS app_integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL DEFAULT 'twilio',
  scope         text NOT NULL DEFAULT 'platform' CHECK (scope IN ('platform','tenant')),
  tenant_slug   text,                 -- null for platform scope
  environment   text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  enabled       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'disconnected'
                CHECK (status IN ('connected','disconnected','error','test_mode')),
  last_tested_at timestamptz,
  last_error    text,                 -- customer-safe message only (no secrets)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_app_integration UNIQUE (provider, scope, tenant_slug, environment)
);

-- ── 2. twilio_connections — Twilio credentials + SMS config (secrets encrypted) ──
CREATE TABLE IF NOT EXISTS twilio_connections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id            uuid NOT NULL REFERENCES app_integrations(id) ON DELETE CASCADE,
  account_sid               text,
  auth_token_encrypted      text,     -- AES-256-GCM bundle (never plaintext)
  api_key_sid               text,
  api_key_secret_encrypted  text,     -- AES-256-GCM bundle (never plaintext)
  messaging_service_sid     text,
  default_from_number       text,     -- E.164
  sms_enabled               boolean NOT NULL DEFAULT true,
  inbound_enabled           boolean NOT NULL DEFAULT true,
  status_callbacks_enabled  boolean NOT NULL DEFAULT true,
  test_mode                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_twilio_connection_integration UNIQUE (integration_id)
);

-- ── 3. twilio_phone_numbers — numbers known/available in the account ─────────
CREATE TABLE IF NOT EXISTS twilio_phone_numbers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  text NOT NULL,        -- E.164
  friendly_name text,
  sms_capable   boolean NOT NULL DEFAULT true,
  voice_capable boolean NOT NULL DEFAULT false,
  source        text NOT NULL DEFAULT 'purchased'
                CHECK (source IN ('purchased','trial','verified_caller','messaging_service')),
  environment   text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_twilio_number_env UNIQUE (phone_number, environment)
);

-- ── 4. tenant_phone_assignments — which tenant owns which number ─────────────
CREATE TABLE IF NOT EXISTS tenant_phone_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug           text NOT NULL,
  phone_number          text NOT NULL,   -- E.164, the RECEIVING number = routing key
  messaging_service_sid text,
  sms_enabled           boolean NOT NULL DEFAULT true,
  voice_enabled         boolean NOT NULL DEFAULT false,
  mode                  text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  environment           text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_message_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A receiving number maps to exactly ONE tenant per environment (routing must
  -- be unambiguous). A tenant may hold several numbers.
  CONSTRAINT uq_assignment_number_env UNIQUE (phone_number, environment)
);
CREATE INDEX IF NOT EXISTS idx_assign_tenant ON tenant_phone_assignments (tenant_slug, environment);

-- ── 5. twilio_message_logs — delivery-status tracking (SID/status/errors) ────
CREATE TABLE IF NOT EXISTS twilio_message_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug   text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number   text,
  to_number     text,
  body_preview  text,                 -- truncated; full body lives in sms_messages
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','accepted','sending','sent','delivered',
                                  'undelivered','failed','canceled','received','simulated')),
  twilio_sid    text,
  error_code    text,
  error_message text,
  environment   text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tml_tenant ON twilio_message_logs (tenant_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tml_sid    ON twilio_message_logs (twilio_sid);

-- ── 6. twilio_webhook_events — idempotency + audit of inbound/status webhooks ─
CREATE TABLE IF NOT EXISTS twilio_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_sid   text NOT NULL,
  event_type    text NOT NULL CHECK (event_type IN ('inbound','status')),
  message_status text,               -- for status callbacks (sent/delivered/…)
  tenant_slug   text,
  environment   text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- The same (sid, event, status) delivered twice by Twilio must be a no-op.
  CONSTRAINT uq_webhook_event UNIQUE (message_sid, event_type, message_status)
);

-- ── 7. RLS: deny-all (service role bypasses; no anon/authenticated policies) ──
ALTER TABLE app_integrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE twilio_connections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE twilio_phone_numbers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_phone_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE twilio_message_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE twilio_webhook_events    ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- ROLLBACK (staging only):
-- DROP TABLE IF EXISTS twilio_webhook_events, twilio_message_logs,
--   tenant_phone_assignments, twilio_phone_numbers, twilio_connections,
--   app_integrations CASCADE;
-- ============================================================================
