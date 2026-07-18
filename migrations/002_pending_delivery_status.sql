-- ============================================================================
-- Migration 002: pending_bookings delivery tracking
--
-- Adds durable, minimal delivery-status tracking to the receptionist's
-- confirmation-link bookings so a notification (SMTP) failure is auditable
-- WITHOUT ever confirming an appointment that the customer did not approve.
--
-- SAFETY / COMPATIBILITY:
--   * Every column is ADD COLUMN IF NOT EXISTS with a NOT-NULL DEFAULT (or
--     nullable), so pre-existing rows are backfilled and never broken.
--   * The CHECK constraint is added idempotently and is satisfied by the
--     backfilled default ('pending').
--   * NO secrets, tokens, internal messages, or raw provider responses are
--     stored — only a small enum status, an attempt counter, a timestamp, and
--     a short machine error CODE.
--
-- HOW TO APPLY: run once in the Supabase SQL Editor (staging, then production).
-- HOW TO REVERT: see the commented DROPs at the bottom.
-- ============================================================================

ALTER TABLE pending_bookings ADD COLUMN IF NOT EXISTS delivery_status          text        NOT NULL DEFAULT 'pending';
ALTER TABLE pending_bookings ADD COLUMN IF NOT EXISTS delivery_attempts        integer     NOT NULL DEFAULT 0;
ALTER TABLE pending_bookings ADD COLUMN IF NOT EXISTS last_delivery_attempt_at timestamptz;
ALTER TABLE pending_bookings ADD COLUMN IF NOT EXISTS delivery_error_code      text;

-- Constrain delivery_status to the known set (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_bookings_delivery_status_chk'
  ) THEN
    ALTER TABLE pending_bookings
      ADD CONSTRAINT pending_bookings_delivery_status_chk
      CHECK (delivery_status IN ('pending','sent','notification_failed','not_required'));
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually to revert):
-- ALTER TABLE pending_bookings DROP CONSTRAINT IF EXISTS pending_bookings_delivery_status_chk;
-- ALTER TABLE pending_bookings DROP COLUMN IF EXISTS delivery_error_code;
-- ALTER TABLE pending_bookings DROP COLUMN IF EXISTS last_delivery_attempt_at;
-- ALTER TABLE pending_bookings DROP COLUMN IF EXISTS delivery_attempts;
-- ALTER TABLE pending_bookings DROP COLUMN IF EXISTS delivery_status;
-- ============================================================================
