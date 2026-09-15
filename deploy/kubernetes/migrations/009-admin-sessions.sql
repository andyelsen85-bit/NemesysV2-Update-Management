-- Server-side administrator sessions for express-session/connect-pg-simple.
-- Safe to run repeatedly during deployment.
CREATE TABLE IF NOT EXISTS public.nemesys_sessions (
  sid varchar(255) PRIMARY KEY NOT NULL,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS nemesys_sessions_expire_idx
  ON public.nemesys_sessions (expire);