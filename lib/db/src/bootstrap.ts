import { sql } from "drizzle-orm";
import { db } from "./index";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS public.nemesys_admin_users (
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
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_audit_entries (
    id text PRIMARY KEY NOT NULL,
    client_id text NOT NULL,
    client_name text NOT NULL,
    timestamp timestamp with time zone DEFAULT now() NOT NULL,
    result text NOT NULL,
    applications jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT nemesys_audit_entries_client_id_unique UNIQUE (client_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_clients (
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
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_ldap_settings (
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
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_server_settings (
    id text PRIMARY KEY NOT NULL,
    sync_port integer DEFAULT 443 NOT NULL,
    admin_https_enabled boolean DEFAULT true NOT NULL,
    admin_username text DEFAULT 'admin' NOT NULL,
    admin_password_hash text,
    client_api_key_hash text,
    client_api_key_encrypted text,
    api_key_last_rotated_at timestamp with time zone
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_software_policies (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    executable text NOT NULL,
    target_version text NOT NULL,
    rule_type text NOT NULL,
    supervised_executables jsonb DEFAULT '[]'::jsonb NOT NULL,
    exe_checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    ini_checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    ini_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    normal_close_timeout_seconds integer DEFAULT 30 NOT NULL,
    update_mode boolean DEFAULT false NOT NULL,
    update_mode_close_timeout_seconds integer DEFAULT 8 NOT NULL,
    allow_postpone boolean DEFAULT false NOT NULL,
    launch_on_exit_update_mode boolean DEFAULT false NOT NULL,
    launch_executable_path text DEFAULT '' NOT NULL,
    launch_arguments text DEFAULT '' NOT NULL,
    update_mode_cycle_id text DEFAULT 'initial' NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_updated timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT nemesys_software_policies_normal_close_timeout_seconds_check
      CHECK (normal_close_timeout_seconds BETWEEN 1 AND 3600)
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_ssl_settings (
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
  )`,
  `ALTER TABLE public.nemesys_clients
    ADD COLUMN IF NOT EXISTS last_poll timestamp with time zone,
    ADD COLUMN IF NOT EXISTS last_successful_sync timestamp with time zone`,
  `ALTER TABLE public.nemesys_software_policies
    ADD COLUMN IF NOT EXISTS allow_postpone boolean NOT NULL DEFAULT false`,
  `DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'nemesys_software_policies'
        AND column_name = 'grace_seconds'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'nemesys_software_policies'
        AND column_name = 'normal_close_timeout_seconds'
    ) THEN
      ALTER TABLE public.nemesys_software_policies
        RENAME COLUMN grace_seconds TO normal_close_timeout_seconds;
    END IF;
  END $$`,
  `ALTER TABLE public.nemesys_software_policies
    ADD COLUMN IF NOT EXISTS normal_close_timeout_seconds integer NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS launch_on_exit_update_mode boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS launch_executable_path text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS launch_arguments text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS update_mode_cycle_id text NOT NULL DEFAULT 'initial'`,
  `UPDATE public.nemesys_software_policies
    SET normal_close_timeout_seconds = LEAST(
      GREATEST(COALESCE(normal_close_timeout_seconds, 1), 1),
      3600
    )
    WHERE normal_close_timeout_seconds IS NULL
      OR normal_close_timeout_seconds < 1
      OR normal_close_timeout_seconds > 3600`,
  `DO $$
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
  END $$`,
  `ALTER TABLE public.nemesys_software_policies
    DROP COLUMN IF EXISTS grace_seconds`,
  `ALTER TABLE public.nemesys_server_settings
    DROP COLUMN IF EXISTS sync_interval_seconds,
    DROP COLUMN IF EXISTS update_mode,
    DROP COLUMN IF EXISTS normal_close_timeout_seconds,
    DROP COLUMN IF EXISTS update_mode_close_timeout_seconds`,
  `UPDATE public.nemesys_server_settings
    SET sync_port = 443
    WHERE id = 'default' AND sync_port = 5187`,
] as const;

export async function ensureDatabaseSchema(): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('nemesys-schema-bootstrap'))`,
    );
    for (const statement of schemaStatements) {
      await transaction.execute(sql.raw(statement));
    }
  });
}
