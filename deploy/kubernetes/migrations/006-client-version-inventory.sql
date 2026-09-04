ALTER TABLE public.nemesys_clients
  ADD COLUMN IF NOT EXISTS installed_version text;

ALTER TABLE public.nemesys_server_settings
  ADD COLUMN IF NOT EXISTS desired_client_version text NOT NULL DEFAULT '1.0.0';