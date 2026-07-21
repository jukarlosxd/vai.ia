-- migrations/004_twilio_connection_states.sql
-- Widens app_integrations.status so a connection can express WHY it is not
-- usable instead of collapsing every failure into 'disconnected'.
--
-- Problem this fixes: the integration row is created with status
-- 'disconnected'/enabled=false, so a connection saved WITHOUT an Auth Token
-- reported "Twilio integration disconnected" — hiding the real cause
-- (token not configured) and implying an administrator had disconnected it.
--
-- New vocabulary:
--   unconfigured         nothing saved yet (initial state)
--   saved                credentials stored but never successfully tested
--   testing              a test is in flight
--   connected            Twilio accepted the stored credentials
--   test_mode            connected, simulation mode
--   authentication_error Twilio rejected the stored credentials
--   configuration_error  missing / undecryptable credentials (local problem)
--   network_error        Twilio unreachable
--   disconnected         explicitly disconnected BY AN ADMINISTRATOR
--   error                legacy generic (kept so old rows stay valid)
--
-- Idempotent: safe to re-run. Staging only — production is untouched.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.app_integrations'::regclass
      AND conname  = 'app_integrations_status_check'
  ) THEN
    ALTER TABLE public.app_integrations DROP CONSTRAINT app_integrations_status_check;
  END IF;

  ALTER TABLE public.app_integrations
    ADD CONSTRAINT app_integrations_status_check
    CHECK (status IN (
      'unconfigured','saved','testing','connected','test_mode',
      'authentication_error','configuration_error','network_error',
      'disconnected','error'
    ));
END $$;

-- Default for newly created integrations is "nothing saved yet", not
-- "an administrator disconnected this".
ALTER TABLE public.app_integrations ALTER COLUMN status SET DEFAULT 'unconfigured';

-- Re-classify rows that the rejected writes froze. While the constraint above
-- was still narrow, every attempt to move a row to 'saved' was rejected by
-- Postgres and swallowed by the store, so a connection whose credentials were
-- stored correctly stayed at 'error' with a stale last_error. Such a row is
-- 'saved' (stored, never verified) — NOT an error, and NOT connected.
-- Rows an administrator genuinely disconnected are left untouched.
UPDATE public.app_integrations ai
SET    status     = 'saved',
       enabled    = false,
       last_error = NULL,
       updated_at = now()
WHERE  ai.provider = 'twilio'
  AND  ai.status   = 'error'
  AND  EXISTS (
         SELECT 1 FROM public.twilio_connections c
         WHERE  c.integration_id      = ai.id
           AND  c.account_sid         IS NOT NULL
           AND  c.auth_token_encrypted IS NOT NULL
       );

-- Verification (no secrets selected — booleans only):
--   SELECT ai.id, ai.environment, ai.status, ai.enabled,
--          c.account_sid          IS NOT NULL AS has_sid,
--          c.auth_token_encrypted IS NOT NULL AS has_token,
--          ai.last_tested_at, ai.last_error
--   FROM   public.app_integrations ai
--   LEFT   JOIN public.twilio_connections c ON c.integration_id = ai.id
--   WHERE  ai.provider = 'twilio';
