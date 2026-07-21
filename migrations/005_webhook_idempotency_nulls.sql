-- migrations/005_webhook_idempotency_nulls.sql
--
-- Fix inbound-webhook idempotency.
--
-- 003 created:
--   CONSTRAINT uq_webhook_event UNIQUE (message_sid, event_type, message_status)
--
-- Inbound events carry message_status = NULL. Under SQL's default semantics a
-- UNIQUE constraint treats every NULL as DISTINCT, so two inbound rows with the
-- same message_sid but NULL status do NOT collide. recordWebhookEvent() relies
-- on a 23505 unique-violation to detect a replay; with NULLs never colliding,
-- the second insert succeeds, firstTime is reported true again, and a retried
-- inbound SMS is processed twice — the AI Receptionist runs twice and (with a
-- real sender) a duplicate reply is billed. Observed live: 9 inbound events
-- with NULL status and 3 message_sids duplicated.
--
-- Postgres 15+ supports UNIQUE ... NULLS NOT DISTINCT, which makes NULLs
-- collide, restoring idempotency atomically and race-safely. Supabase is on
-- Postgres 17.
--
-- Idempotent: safe to re-run. Staging only — production is untouched.

-- 1. Collapse existing duplicates, keeping the earliest row of each group, so
--    the stricter constraint can be created. Applies to BOTH NULL-status
--    (inbound) and any accidental status duplicates.
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY message_sid, event_type, message_status
           ORDER BY created_at, ctid
         ) AS rn
  FROM public.twilio_webhook_events
)
DELETE FROM public.twilio_webhook_events e
USING  ranked r
WHERE  e.ctid = r.ctid
  AND  r.rn > 1;

-- 2. Recreate the constraint with NULLS NOT DISTINCT so (sid, 'inbound', NULL)
--    can occur at most once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.twilio_webhook_events'::regclass
      AND conname  = 'uq_webhook_event'
  ) THEN
    ALTER TABLE public.twilio_webhook_events DROP CONSTRAINT uq_webhook_event;
  END IF;

  ALTER TABLE public.twilio_webhook_events
    ADD CONSTRAINT uq_webhook_event
    UNIQUE NULLS NOT DISTINCT (message_sid, event_type, message_status);
END $$;

-- Verification:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='uq_webhook_event';
--   -- expect: UNIQUE NULLS NOT DISTINCT (message_sid, event_type, message_status)
--   SELECT message_sid, event_type, message_status, count(*)
--   FROM public.twilio_webhook_events
--   GROUP BY 1,2,3 HAVING count(*) > 1;   -- expect: zero rows
