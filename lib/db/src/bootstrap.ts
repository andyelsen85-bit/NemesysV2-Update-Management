import { sql } from "drizzle-orm";
import { db } from "./index";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS public.nemesys_sessions (
    sid varchar(255) PRIMARY KEY NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS nemesys_sessions_expire_idx
    ON public.nemesys_sessions (expire)`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_security_buckets (
    bucket_key text PRIMARY KEY NOT NULL,
    bucket_kind text NOT NULL,
    failure_count integer NOT NULL DEFAULT 0,
    window_started_at timestamp with time zone NOT NULL DEFAULT now(),
    locked_until timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS nemesys_security_buckets_updated_idx
    ON public.nemesys_security_buckets (updated_at)`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_admin_users (
    id text PRIMARY KEY NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    email text DEFAULT '' NOT NULL,
    source text DEFAULT 'ldap' NOT NULL,
    directory_dn text,
    password_hash text,
    must_change_password boolean DEFAULT false NOT NULL,
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
  `DO $$
   DECLARE owner_name text;
   BEGIN
     SELECT pg_get_userbyid(relowner) INTO owner_name
       FROM pg_class WHERE oid = 'public.nemesys_audit_entries'::regclass;
     IF owner_name IS DISTINCT FROM 'nemesys_audit_owner' THEN
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nemesys_audit_owner') THEN
           CREATE ROLE nemesys_audit_owner NOLOGIN;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nemesys_app') THEN
           CREATE ROLE nemesys_app NOLOGIN;
         END IF;
         EXECUTE $fn$CREATE OR REPLACE FUNCTION public.nemesys_protect_audit_entries_mutation()
           RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $body$
           BEGIN
             IF current_user = 'nemesys_audit_owner' THEN
               IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
               IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
               RETURN NULL;
             END IF;
             RAISE EXCEPTION 'Direct % on public.nemesys_audit_entries is prohibited', TG_OP USING ERRCODE = '42501';
           END $body$ $fn$;
         EXECUTE $fn$CREATE OR REPLACE FUNCTION public.nemesys_replace_latest_audit_report(
           p_id text, p_client_id text, p_client_name text, p_timestamp timestamptz,
           p_result text, p_applications jsonb)
           RETURNS public.nemesys_audit_entries LANGUAGE plpgsql SECURITY DEFINER
           SET search_path = pg_catalog, public AS $body$
           DECLARE r public.nemesys_audit_entries;
           BEGIN
             DELETE FROM public.nemesys_audit_entries WHERE client_id = p_client_id;
             INSERT INTO public.nemesys_audit_entries
               (id, client_id, client_name, timestamp, result, applications)
             VALUES (p_id, p_client_id, p_client_name, p_timestamp, p_result, p_applications)
             RETURNING * INTO r;
             RETURN r;
           END $body$ $fn$;
         EXECUTE $fn$CREATE OR REPLACE FUNCTION public.nemesys_delete_inactive_audits(p_client_ids text[])
           RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $body$
           DECLARE n integer;
           BEGIN
             DELETE FROM public.nemesys_audit_entries WHERE client_id = ANY(p_client_ids);
             GET DIAGNOSTICS n = ROW_COUNT;
             RETURN n;
           END $body$ $fn$;
         EXECUTE $fn$CREATE OR REPLACE FUNCTION public.nemesys_restore_audit_entries(p_rows jsonb)
           RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $body$
           BEGIN
             IF jsonb_typeof(p_rows) <> 'array' THEN
               RAISE EXCEPTION 'Audit restore rows must be a JSON array';
             END IF;
             DELETE FROM public.nemesys_audit_entries;
             INSERT INTO public.nemesys_audit_entries
               SELECT * FROM jsonb_populate_recordset(NULL::public.nemesys_audit_entries, p_rows);
           END $body$ $fn$;
           EXECUTE 'DROP TRIGGER IF EXISTS nemesys_audit_entries_protect_row_writes
             ON public.nemesys_audit_entries';
           EXECUTE 'DROP TRIGGER IF EXISTS nemesys_audit_entries_protect_truncate
             ON public.nemesys_audit_entries';
           EXECUTE 'CREATE TRIGGER nemesys_audit_entries_protect_row_writes
            BEFORE UPDATE OR DELETE ON public.nemesys_audit_entries
            FOR EACH ROW EXECUTE FUNCTION public.nemesys_protect_audit_entries_mutation()';
          EXECUTE 'CREATE TRIGGER nemesys_audit_entries_protect_truncate
            BEFORE TRUNCATE ON public.nemesys_audit_entries
            FOR EACH STATEMENT EXECUTE FUNCTION public.nemesys_protect_audit_entries_mutation()';
          REVOKE UPDATE, DELETE, TRUNCATE ON public.nemesys_audit_entries FROM PUBLIC;
           REVOKE ALL ON FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) FROM PUBLIC;
           REVOKE ALL ON FUNCTION public.nemesys_delete_inactive_audits(text[]) FROM PUBLIC;
           REVOKE ALL ON FUNCTION public.nemesys_restore_audit_entries(jsonb) FROM PUBLIC;
           GRANT SELECT ON public.nemesys_audit_entries TO nemesys_app;
           GRANT EXECUTE ON FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) TO nemesys_app;
           GRANT EXECUTE ON FUNCTION public.nemesys_delete_inactive_audits(text[]) TO nemesys_app;
           GRANT EXECUTE ON FUNCTION public.nemesys_restore_audit_entries(jsonb) TO nemesys_app;
           EXECUTE format('GRANT nemesys_app TO %I', session_user);
          EXECUTE 'ALTER TABLE public.nemesys_audit_entries OWNER TO nemesys_audit_owner';
         EXECUTE 'ALTER FUNCTION public.nemesys_protect_audit_entries_mutation() OWNER TO nemesys_audit_owner';
         EXECUTE 'ALTER FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) OWNER TO nemesys_audit_owner';
         EXECUTE 'ALTER FUNCTION public.nemesys_delete_inactive_audits(text[]) OWNER TO nemesys_audit_owner';
         EXECUTE 'ALTER FUNCTION public.nemesys_restore_audit_entries(jsonb) OWNER TO nemesys_audit_owner';
       EXCEPTION WHEN insufficient_privilege THEN
         RAISE EXCEPTION 'Audit protection needs elevated database rights to provision nemesys_audit_owner; run bootstrap once as database owner/superuser, then restart the API. Original error: %', SQLERRM;
       END;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.nemesys_audit_entries'::regclass
         AND tgname = 'nemesys_audit_entries_protect_row_writes'
     ) THEN
       CREATE TRIGGER nemesys_audit_entries_protect_row_writes
       BEFORE UPDATE OR DELETE ON public.nemesys_audit_entries
       FOR EACH ROW EXECUTE FUNCTION public.nemesys_protect_audit_entries_mutation();
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.nemesys_audit_entries'::regclass
         AND tgname = 'nemesys_audit_entries_protect_truncate'
     ) THEN
       CREATE TRIGGER nemesys_audit_entries_protect_truncate
       BEFORE TRUNCATE ON public.nemesys_audit_entries
       FOR EACH STATEMENT EXECUTE FUNCTION public.nemesys_protect_audit_entries_mutation();
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'nemesys_protect_audit_entries_mutation'
     ) THEN
       RAISE EXCEPTION 'Required audit protection function is missing';
     END IF;
      IF (SELECT pg_get_userbyid(relowner) FROM pg_class
          WHERE oid = 'public.nemesys_audit_entries'::regclass) <> 'nemesys_audit_owner'
         OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('nemesys_protect_audit_entries_mutation',
                 'nemesys_replace_latest_audit_report', 'nemesys_delete_inactive_audits',
                 'nemesys_restore_audit_entries')
               AND pg_get_userbyid(p.proowner) = 'nemesys_audit_owner') <> 4
         OR (SELECT count(*) FROM pg_trigger t
             JOIN pg_proc p ON p.oid = t.tgfoid
             JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE t.tgrelid = 'public.nemesys_audit_entries'::regclass
               AND t.tgenabled <> 'D'
               AND n.nspname = 'public'
               AND p.proname = 'nemesys_protect_audit_entries_mutation'
               AND (
                 (t.tgname = 'nemesys_audit_entries_protect_row_writes' AND t.tgtype = 27)
                 OR (t.tgname = 'nemesys_audit_entries_protect_truncate' AND t.tgtype = 34)
               )) <> 2 THEN
        RAISE EXCEPTION 'Required audit protection owner, function, or triggers are missing/disabled; provision nemesys_audit_owner with elevated rights';
     END IF;
      IF current_setting('is_superuser') = 'on' THEN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nemesys_app') THEN
          CREATE ROLE nemesys_app NOLOGIN;
        END IF;
        GRANT SELECT ON public.nemesys_audit_entries TO nemesys_app;
        GRANT EXECUTE ON FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) TO nemesys_app;
        GRANT EXECUTE ON FUNCTION public.nemesys_delete_inactive_audits(text[]) TO nemesys_app;
        GRANT EXECUTE ON FUNCTION public.nemesys_restore_audit_entries(jsonb) TO nemesys_app;
        EXECUTE format('GRANT nemesys_app TO %I', session_user);
      ELSIF NOT pg_has_role(current_user, 'nemesys_app', 'MEMBER')
         OR NOT has_table_privilege(current_user, 'public.nemesys_audit_entries', 'SELECT')
         OR NOT has_function_privilege(current_user, 'public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb)', 'EXECUTE')
         OR NOT has_function_privilege(current_user, 'public.nemesys_delete_inactive_audits(text[])', 'EXECUTE')
         OR NOT has_function_privilege(current_user, 'public.nemesys_restore_audit_entries(jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Application database role must be a member of nemesys_app with the required audit SELECT and routine EXECUTE grants';
      END IF;
      IF current_setting('is_superuser') <> 'on' AND (
        has_table_privilege(current_user, 'public.nemesys_audit_entries', 'UPDATE')
        OR has_table_privilege(current_user, 'public.nemesys_audit_entries', 'DELETE')
        OR has_table_privilege(current_user, 'public.nemesys_audit_entries', 'TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Application database role has forbidden direct audit mutation privileges';
      END IF;
   END
   $$`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_api_key_reveal_audits (
    id text PRIMARY KEY NOT NULL,
    username text NOT NULL,
    timestamp timestamp with time zone DEFAULT now() NOT NULL
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
    installed_version text,
    certificate_status text DEFAULT 'valid' NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_ldap_settings (
    id text PRIMARY KEY NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    url text DEFAULT '' NOT NULL,
    bind_dn text DEFAULT '' NOT NULL,
    bind_password_encrypted text,
    base_dn text DEFAULT '' NOT NULL,
    computer_base_dn text DEFAULT '' NOT NULL,
    directory_auto_sync_enabled boolean DEFAULT false NOT NULL,
    directory_sync_interval_minutes integer DEFAULT 60 NOT NULL,
    user_filter text DEFAULT '(&(objectClass=person)(sAMAccountName={{username}}))' NOT NULL,
    username_attribute text DEFAULT 'sAMAccountName' NOT NULL,
    display_name_attribute text DEFAULT 'displayName' NOT NULL,
    email_attribute text DEFAULT 'mail' NOT NULL,
    verify_tls_certificate boolean DEFAULT true NOT NULL,
    ca_certificate_pem text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_directory_cache_status (
    id text PRIMARY KEY NOT NULL, last_successful_sync_at timestamp with time zone,
    last_attempt_at timestamp with time zone, last_error text
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_directory_computers (
    id text PRIMARY KEY NOT NULL, hostname text NOT NULL UNIQUE, sam_account_name text NOT NULL,
    dns_host_name text DEFAULT '' NOT NULL, distinguished_name text NOT NULL, enabled boolean NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_directory_groups (
    id text PRIMARY KEY NOT NULL, name text NOT NULL, sam_account_name text DEFAULT '' NOT NULL,
    distinguished_name text NOT NULL, active boolean DEFAULT true NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_directory_computer_groups (
    computer_id text NOT NULL, group_id text NOT NULL, UNIQUE(computer_id, group_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_software_policy_target_groups (
    policy_id text NOT NULL, group_id text NOT NULL, UNIQUE(policy_id, group_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_server_settings (
    id text PRIMARY KEY NOT NULL,
    sync_port integer DEFAULT 443 NOT NULL,
    admin_https_enabled boolean DEFAULT true NOT NULL,
    desired_client_version text DEFAULT '1.0.0' NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS public.nemesys_adfs_settings (
    id text PRIMARY KEY NOT NULL,
    enabled boolean,
    display_name text,
    issuer text,
    discovery_url text,
    client_id text,
    client_secret_encrypted text,
    client_secret_cleared boolean,
    redirect_uri text,
    scopes text,
    username_claim text,
    email_claim text,
    display_name_claim text,
    ca_certificate_pem text,
    ca_certificate_cleared boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_adfs_identity_mappings (
    id text PRIMARY KEY NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    admin_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT nemesys_adfs_identity_mappings_issuer_subject_unique UNIQUE (issuer, subject),
    CONSTRAINT nemesys_adfs_identity_mappings_admin_user_unique UNIQUE (admin_user_id)
  )`,
  `ALTER TABLE public.nemesys_adfs_settings
    ADD COLUMN IF NOT EXISTS client_secret_cleared boolean,
    ADD COLUMN IF NOT EXISTS ca_certificate_cleared boolean`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nemesys_directory_computer_groups_computer_fk') THEN
      ALTER TABLE public.nemesys_directory_computer_groups
        ADD CONSTRAINT nemesys_directory_computer_groups_computer_fk
        FOREIGN KEY (computer_id) REFERENCES public.nemesys_directory_computers(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nemesys_directory_computer_groups_group_fk') THEN
      ALTER TABLE public.nemesys_directory_computer_groups
        ADD CONSTRAINT nemesys_directory_computer_groups_group_fk
        FOREIGN KEY (group_id) REFERENCES public.nemesys_directory_groups(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nemesys_software_policy_target_groups_policy_fk') THEN
      ALTER TABLE public.nemesys_software_policy_target_groups
        ADD CONSTRAINT nemesys_software_policy_target_groups_policy_fk
        FOREIGN KEY (policy_id) REFERENCES public.nemesys_software_policies(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nemesys_software_policy_target_groups_group_fk') THEN
      ALTER TABLE public.nemesys_software_policy_target_groups
        ADD CONSTRAINT nemesys_software_policy_target_groups_group_fk
        FOREIGN KEY (group_id) REFERENCES public.nemesys_directory_groups(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nemesys_adfs_identity_mappings_admin_user_fk') THEN
      ALTER TABLE public.nemesys_adfs_identity_mappings
        ADD CONSTRAINT nemesys_adfs_identity_mappings_admin_user_fk
        FOREIGN KEY (admin_user_id) REFERENCES public.nemesys_admin_users(id) ON DELETE CASCADE;
    END IF;
  END $$`,
  `ALTER TABLE public.nemesys_clients
    ADD COLUMN IF NOT EXISTS last_poll timestamp with time zone,
    ADD COLUMN IF NOT EXISTS last_successful_sync timestamp with time zone,
    ADD COLUMN IF NOT EXISTS installed_version text`,
  `ALTER TABLE public.nemesys_server_settings
     ADD COLUMN IF NOT EXISTS desired_client_version text NOT NULL DEFAULT '1.0.0',
     ADD COLUMN IF NOT EXISTS admin_session_generation integer NOT NULL DEFAULT 0`,
  `ALTER TABLE public.nemesys_admin_users
     ADD COLUMN IF NOT EXISTS password_hash text,
     ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS public.nemesys_security_state (
     id text PRIMARY KEY NOT NULL,
     admin_session_generation integer NOT NULL DEFAULT 0,
     CONSTRAINT nemesys_security_state_singleton CHECK (id = 'default'),
     CONSTRAINT nemesys_security_state_generation_nonnegative CHECK (admin_session_generation >= 0)
   )`,
  `DO $$
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
   END $$`,
  `INSERT INTO public.nemesys_security_state (id, admin_session_generation)
   SELECT 'default', COALESCE(MAX(admin_session_generation), 0)
   FROM public.nemesys_server_settings
   ON CONFLICT (id) DO NOTHING`,
  `ALTER TABLE public.nemesys_ldap_settings
    ADD COLUMN IF NOT EXISTS computer_base_dn text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS directory_auto_sync_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS directory_sync_interval_minutes integer NOT NULL DEFAULT 60`,
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
