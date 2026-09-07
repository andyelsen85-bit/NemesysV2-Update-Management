CREATE TABLE IF NOT EXISTS public.nemesys_api_key_reveal_audits (
  id text PRIMARY KEY NOT NULL,
  username text NOT NULL,
  timestamp timestamp with time zone DEFAULT now() NOT NULL
);