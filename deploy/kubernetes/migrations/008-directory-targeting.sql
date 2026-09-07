ALTER TABLE public.nemesys_ldap_settings
  ADD COLUMN IF NOT EXISTS computer_base_dn text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS directory_auto_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS directory_sync_interval_minutes integer NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS public.nemesys_directory_cache_status (
  id text PRIMARY KEY NOT NULL,
  last_successful_sync_at timestamp with time zone,
  last_attempt_at timestamp with time zone,
  last_error text
);

CREATE TABLE IF NOT EXISTS public.nemesys_directory_computers (
  id text PRIMARY KEY NOT NULL,
  hostname text NOT NULL UNIQUE,
  sam_account_name text NOT NULL,
  dns_host_name text NOT NULL DEFAULT '',
  distinguished_name text NOT NULL,
  enabled boolean NOT NULL,
  synced_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nemesys_directory_groups (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  sam_account_name text NOT NULL DEFAULT '',
  distinguished_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  synced_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nemesys_directory_computer_groups (
  computer_id text NOT NULL,
  group_id text NOT NULL,
  CONSTRAINT nemesys_directory_computer_groups_computer_fk
    FOREIGN KEY (computer_id) REFERENCES public.nemesys_directory_computers(id) ON DELETE CASCADE,
  CONSTRAINT nemesys_directory_computer_groups_group_fk
    FOREIGN KEY (group_id) REFERENCES public.nemesys_directory_groups(id) ON DELETE CASCADE,
  UNIQUE (computer_id, group_id)
);

CREATE TABLE IF NOT EXISTS public.nemesys_software_policy_target_groups (
  policy_id text NOT NULL,
  group_id text NOT NULL,
  CONSTRAINT nemesys_software_policy_target_groups_policy_fk
    FOREIGN KEY (policy_id) REFERENCES public.nemesys_software_policies(id) ON DELETE CASCADE,
  CONSTRAINT nemesys_software_policy_target_groups_group_fk
    FOREIGN KEY (group_id) REFERENCES public.nemesys_directory_groups(id),
  UNIQUE (policy_id, group_id)
);