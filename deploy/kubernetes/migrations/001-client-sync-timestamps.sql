ALTER TABLE public.nemesys_clients
  ADD COLUMN IF NOT EXISTS last_poll timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_successful_sync timestamp with time zone;