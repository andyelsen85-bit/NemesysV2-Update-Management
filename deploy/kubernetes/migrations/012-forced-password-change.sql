-- Add per-local-account credentials and first-login password-change state.
-- API startup applies the same idempotent upgrade automatically.
BEGIN;

ALTER TABLE public.nemesys_admin_users
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMIT;