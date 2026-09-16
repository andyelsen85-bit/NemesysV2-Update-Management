-- Protect the latest-audit-per-client invariant from direct destructive writes.
-- Safe to run repeatedly during deployment.
BEGIN;

CREATE OR REPLACE FUNCTION public.nemesys_protect_audit_entries_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'nemesys_audit_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'Direct % on public.nemesys_audit_entries is prohibited',
    TG_OP USING ERRCODE = '42501';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nemesys_audit_owner') THEN
    CREATE ROLE nemesys_audit_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nemesys_app') THEN
    CREATE ROLE nemesys_app NOLOGIN;
  END IF;
END
$$;

ALTER TABLE public.nemesys_audit_entries OWNER TO nemesys_audit_owner;
ALTER FUNCTION public.nemesys_protect_audit_entries_mutation() OWNER TO nemesys_audit_owner;
REVOKE UPDATE, DELETE, TRUNCATE ON public.nemesys_audit_entries FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.nemesys_delete_inactive_audits(p_client_ids text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.nemesys_audit_entries WHERE client_id = ANY(p_client_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.nemesys_restore_audit_entries(p_rows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'Audit restore rows must be a JSON array'; END IF;
  DELETE FROM public.nemesys_audit_entries;
  INSERT INTO public.nemesys_audit_entries
    SELECT * FROM jsonb_populate_recordset(NULL::public.nemesys_audit_entries, p_rows);
END $$;

CREATE OR REPLACE FUNCTION public.nemesys_replace_latest_audit_report(
  p_id text, p_client_id text, p_client_name text, p_timestamp timestamptz,
  p_result text, p_applications jsonb)
RETURNS public.nemesys_audit_entries LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE r public.nemesys_audit_entries;
BEGIN
  DELETE FROM public.nemesys_audit_entries WHERE client_id = p_client_id;
  INSERT INTO public.nemesys_audit_entries
    (id, client_id, client_name, timestamp, result, applications)
  VALUES (p_id, p_client_id, p_client_name, p_timestamp, p_result, p_applications)
  RETURNING * INTO r;
  RETURN r;
END $$;

ALTER FUNCTION public.nemesys_delete_inactive_audits(text[]) OWNER TO nemesys_audit_owner;
ALTER FUNCTION public.nemesys_restore_audit_entries(jsonb) OWNER TO nemesys_audit_owner;
ALTER FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) OWNER TO nemesys_audit_owner;
REVOKE ALL ON FUNCTION public.nemesys_delete_inactive_audits(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nemesys_restore_audit_entries(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) FROM PUBLIC;
GRANT SELECT ON public.nemesys_audit_entries TO nemesys_app;
GRANT EXECUTE ON FUNCTION public.nemesys_delete_inactive_audits(text[]) TO nemesys_app;
GRANT EXECUTE ON FUNCTION public.nemesys_restore_audit_entries(jsonb) TO nemesys_app;
GRANT EXECUTE ON FUNCTION public.nemesys_replace_latest_audit_report(text,text,text,timestamptz,text,jsonb) TO nemesys_app;

DO $$
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
  ALTER TABLE public.nemesys_audit_entries
    ENABLE TRIGGER nemesys_audit_entries_protect_row_writes;
  ALTER TABLE public.nemesys_audit_entries
    ENABLE TRIGGER nemesys_audit_entries_protect_truncate;
END
$$;

DO $$
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
  IF (
    SELECT count(*) FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE t.tgrelid = 'public.nemesys_audit_entries'::regclass
      AND t.tgenabled <> 'D'
      AND n.nspname = 'public'
      AND p.proname = 'nemesys_protect_audit_entries_mutation'
      AND (
        (t.tgname = 'nemesys_audit_entries_protect_row_writes' AND t.tgtype = 27)
        OR (t.tgname = 'nemesys_audit_entries_protect_truncate' AND t.tgtype = 34)
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Required audit protection triggers are missing or disabled';
  END IF;
END
$$;

COMMIT;