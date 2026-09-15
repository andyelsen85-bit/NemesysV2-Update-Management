-- Durable administrator session generations and distributed security throttles.
-- Safe to run repeatedly during deployment.
ALTER TABLE public.nemesys_server_settings
  ADD COLUMN IF NOT EXISTS admin_session_generation integer NOT NULL DEFAULT 0;

-- This singleton is security state, not application data.  It must be excluded
-- from application backup/restore and from application-data restore tooling.
CREATE TABLE IF NOT EXISTS public.nemesys_security_state (
  id text PRIMARY KEY NOT NULL,
  admin_session_generation integer NOT NULL DEFAULT 0,
  CONSTRAINT nemesys_security_state_singleton CHECK (id = 'default'),
  CONSTRAINT nemesys_security_state_generation_nonnegative CHECK (admin_session_generation >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nemesys_security_state_singleton'
      AND conrelid = 'public.nemesys_security_state'::regclass
  ) THEN
    ALTER TABLE public.nemesys_security_state
      ADD CONSTRAINT nemesys_security_state_singleton CHECK (id = 'default');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nemesys_security_state_generation_nonnegative'
      AND conrelid = 'public.nemesys_security_state'::regclass
  ) THEN
    ALTER TABLE public.nemesys_security_state
      ADD CONSTRAINT nemesys_security_state_generation_nonnegative
      CHECK (admin_session_generation >= 0);
  END IF;
END $$;

-- Carry the legacy value forward once.  On later idempotent runs the
-- compatibility column must not influence the authoritative state.
INSERT INTO public.nemesys_security_state (id, admin_session_generation)
SELECT 'default', COALESCE(MAX(admin_session_generation), 0)
FROM public.nemesys_server_settings
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.nemesys_security_buckets (
  bucket_key text PRIMARY KEY NOT NULL,
  bucket_kind text NOT NULL,
  failure_count integer NOT NULL DEFAULT 0,
  window_started_at timestamp with time zone NOT NULL DEFAULT now(),
  locked_until timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nemesys_security_buckets_updated_idx
  ON public.nemesys_security_buckets (updated_at);