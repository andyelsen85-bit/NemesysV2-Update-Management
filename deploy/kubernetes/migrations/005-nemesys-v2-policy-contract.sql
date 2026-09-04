-- Preserve prior grace values while moving close configuration to each policy.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'nemesys_software_policies'
      AND column_name = 'grace_seconds'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'nemesys_software_policies'
      AND column_name = 'normal_close_timeout_seconds'
  ) THEN
    ALTER TABLE public.nemesys_software_policies
      RENAME COLUMN grace_seconds TO normal_close_timeout_seconds;
  END IF;
END $$;

ALTER TABLE public.nemesys_software_policies
  ADD COLUMN IF NOT EXISTS normal_close_timeout_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS launch_on_exit_update_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS launch_executable_path text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS launch_arguments text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS update_mode_cycle_id text NOT NULL DEFAULT 'initial';

UPDATE public.nemesys_software_policies
  SET normal_close_timeout_seconds = LEAST(
    GREATEST(COALESCE(normal_close_timeout_seconds, 1), 1),
    3600
  )
  WHERE normal_close_timeout_seconds IS NULL
     OR normal_close_timeout_seconds < 1
     OR normal_close_timeout_seconds > 3600;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nemesys_software_policies_normal_close_timeout_seconds_check'
      AND conrelid = 'public.nemesys_software_policies'::regclass
  ) THEN
    ALTER TABLE public.nemesys_software_policies
      ADD CONSTRAINT nemesys_software_policies_normal_close_timeout_seconds_check
      CHECK (normal_close_timeout_seconds BETWEEN 1 AND 3600);
  END IF;
END $$;

ALTER TABLE public.nemesys_software_policies
  DROP COLUMN IF EXISTS grace_seconds;

ALTER TABLE public.nemesys_server_settings
  DROP COLUMN IF EXISTS sync_interval_seconds,
  DROP COLUMN IF EXISTS update_mode,
  DROP COLUMN IF EXISTS normal_close_timeout_seconds,
  DROP COLUMN IF EXISTS update_mode_close_timeout_seconds;