CREATE TABLE IF NOT EXISTS public.nemesys_admin_users (
  id text PRIMARY KEY NOT NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  email text DEFAULT '' NOT NULL,
  source text DEFAULT 'ldap' NOT NULL,
  directory_dn text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT nemesys_admin_users_username_unique UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS public.nemesys_audit_entries (
  id text PRIMARY KEY NOT NULL,
  client_id text NOT NULL,
  client_name text NOT NULL,
  timestamp timestamp with time zone DEFAULT now() NOT NULL,
  result text NOT NULL,
  applications jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nemesys_clients (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  hostname text NOT NULL,
  address text NOT NULL,
  status text DEFAULT 'stale' NOT NULL,
  last_sync timestamp with time zone,
  last_poll timestamp with time zone,
  last_successful_sync timestamp with time zone,
  sync_version text DEFAULT '1.0.0' NOT NULL,
  certificate_status text DEFAULT 'valid' NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nemesys_ldap_settings (
  id text PRIMARY KEY NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  url text DEFAULT '' NOT NULL,
  bind_dn text DEFAULT '' NOT NULL,
  bind_password_encrypted text,
  base_dn text DEFAULT '' NOT NULL,
  user_filter text DEFAULT '(&(objectClass=person)(sAMAccountName={{username}}))' NOT NULL,
  username_attribute text DEFAULT 'sAMAccountName' NOT NULL,
  display_name_attribute text DEFAULT 'displayName' NOT NULL,
  email_attribute text DEFAULT 'mail' NOT NULL,
  verify_tls_certificate boolean DEFAULT true NOT NULL,
  ca_certificate_pem text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nemesys_server_settings (
  id text PRIMARY KEY NOT NULL,
  sync_interval_seconds integer DEFAULT 300 NOT NULL,
  sync_port integer DEFAULT 443 NOT NULL,
  admin_https_enabled boolean DEFAULT true NOT NULL,
  admin_username text DEFAULT 'admin' NOT NULL,
  admin_password_hash text,
  client_api_key_hash text,
  client_api_key_encrypted text,
  api_key_last_rotated_at timestamp with time zone,
  update_mode boolean DEFAULT false NOT NULL,
  normal_close_timeout_seconds integer DEFAULT 30 NOT NULL,
  update_mode_close_timeout_seconds integer DEFAULT 8 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nemesys_software_policies (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  executable text NOT NULL,
  target_version text NOT NULL,
  rule_type text NOT NULL,
  supervised_executables jsonb DEFAULT '[]'::jsonb NOT NULL,
  exe_checks jsonb DEFAULT '[]'::jsonb NOT NULL,
  ini_checks jsonb DEFAULT '[]'::jsonb NOT NULL,
  ini_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
  grace_seconds integer DEFAULT 30 NOT NULL,
  update_mode boolean DEFAULT false NOT NULL,
  update_mode_close_timeout_seconds integer DEFAULT 8 NOT NULL,
  allow_postpone boolean DEFAULT false NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  last_updated timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nemesys_ssl_settings (
  id text PRIMARY KEY NOT NULL,
  certificate_pem text,
  private_key_pem_encrypted text,
  chain_pem text,
  certificate_fingerprint text,
  certificate_subject text,
  certificate_expires_at timestamp with time zone,
  force_https boolean DEFAULT false NOT NULL,
  hsts_enabled boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);