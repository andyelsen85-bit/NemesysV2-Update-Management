BEGIN;

LOCK TABLE public.nemesys_audit_entries IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM public.nemesys_audit_entries AS audit
USING (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY client_id
      ORDER BY timestamp DESC, id DESC
    ) AS row_number
  FROM public.nemesys_audit_entries
) AS ranked
WHERE audit.id = ranked.id
  AND ranked.row_number > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.nemesys_audit_entries'::regclass
      AND conname = 'nemesys_audit_entries_client_id_unique'
  ) THEN
    ALTER TABLE public.nemesys_audit_entries
      ADD CONSTRAINT nemesys_audit_entries_client_id_unique UNIQUE (client_id);
  END IF;
END
$$;

COMMIT;