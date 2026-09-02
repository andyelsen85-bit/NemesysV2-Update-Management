ALTER TABLE public.nemesys_software_policies
  ADD COLUMN IF NOT EXISTS allow_postpone boolean NOT NULL DEFAULT false;