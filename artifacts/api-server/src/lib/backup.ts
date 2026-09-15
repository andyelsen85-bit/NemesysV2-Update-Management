import { sql, type SQL } from "drizzle-orm";

export const BACKUP_FORMAT_VERSION = 2;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** An upload is structurally valid JSON but cannot be safely restored. */
export class BackupValidationError extends Error {
  constructor(message = "Backup cannot be restored.") {
    super(message);
    this.name = "BackupValidationError";
  }
}

/**
 * Keep this list explicit. It is the application data boundary: the
 * connect-pg-simple table is deliberately not part of a backup.
 */
export const APPLICATION_TABLES = [
  "nemesys_admin_users",
  "nemesys_audit_entries",
  "nemesys_api_key_reveal_audits",
  "nemesys_clients",
  "nemesys_ldap_settings",
  "nemesys_directory_cache_status",
  "nemesys_directory_computers",
  "nemesys_directory_groups",
  "nemesys_directory_computer_groups",
  "nemesys_software_policy_target_groups",
  "nemesys_server_settings",
  "nemesys_software_policies",
  "nemesys_ssl_settings",
  "nemesys_adfs_settings",
  "nemesys_adfs_identity_mappings",
] as const;

export type ApplicationTable = (typeof APPLICATION_TABLES)[number];
export type BackupRows = Record<ApplicationTable, Record<string, unknown>[]>;
export type BackupIdentity = "none" | "always" | "by-default";
export interface BackupColumn {
  name: string;
  canonicalType: string;
  nullable: boolean;
  defaultExpression: string | null;
  generatedExpression: string | null;
  identity: BackupIdentity;
}
export type BackupSchemaManifest = Record<ApplicationTable, BackupColumn[]>;
export interface BackupDocument {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  generatedAt: string;
  schemaManifest: BackupSchemaManifest;
  tables: BackupRows;
}

// Child tables must be emptied first; this order also makes the replacement
// behavior explicit for databases with the application's foreign keys enabled.
export const DELETE_ORDER: readonly ApplicationTable[] = [
  "nemesys_adfs_identity_mappings",
  "nemesys_directory_computer_groups",
  "nemesys_software_policy_target_groups",
  "nemesys_audit_entries",
  "nemesys_admin_users",
  "nemesys_clients",
  "nemesys_ldap_settings",
  "nemesys_directory_cache_status",
  "nemesys_directory_computers",
  "nemesys_directory_groups",
  "nemesys_server_settings",
  "nemesys_software_policies",
  "nemesys_ssl_settings",
  "nemesys_adfs_settings",
  "nemesys_api_key_reveal_audits",
];

export const INSERT_ORDER: readonly ApplicationTable[] = [
  "nemesys_admin_users",
  "nemesys_clients",
  "nemesys_directory_computers",
  "nemesys_directory_groups",
  "nemesys_ldap_settings",
  "nemesys_directory_cache_status",
  "nemesys_server_settings",
  "nemesys_software_policies",
  "nemesys_ssl_settings",
  "nemesys_adfs_settings",
  "nemesys_api_key_reveal_audits",
  "nemesys_audit_entries",
  "nemesys_directory_computer_groups",
  "nemesys_software_policy_target_groups",
  "nemesys_adfs_identity_mappings",
];

type Transaction = {
  execute: (query: SQL) => Promise<{ rows: unknown[] }>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateBackupDocument(value: unknown): value is BackupDocument {
  if (!isPlainObject(value)
    || !hasExactlyKeys(value, ["formatVersion", "generatedAt", "schemaManifest", "tables"])
    || value.formatVersion !== BACKUP_FORMAT_VERSION
    || typeof value.generatedAt !== "string"
    || Number.isNaN(Date.parse(value.generatedAt))) {
    return false;
  }
  const tables = value.tables;
  if (!isPlainObject(tables) || !hasExactlyKeys(tables, APPLICATION_TABLES)) return false;
  const schemaManifest = value.schemaManifest;
  if (!isPlainObject(schemaManifest) || !hasExactlyKeys(schemaManifest, APPLICATION_TABLES)) return false;
  if (!APPLICATION_TABLES.every((table) => {
    const rows = tables[table];
    return Array.isArray(rows) && rows.every(isPlainObject);
  })) return false;
  return APPLICATION_TABLES.every((table) => {
    const columns = schemaManifest[table];
    return Array.isArray(columns) && columns.every((column) => (
      isPlainObject(column)
      && hasExactlyKeys(column, [
        "name",
        "canonicalType",
        "nullable",
        "defaultExpression",
        "generatedExpression",
        "identity",
      ])
      && typeof column.name === "string"
      && typeof column.canonicalType === "string"
      && typeof column.nullable === "boolean"
      && (typeof column.defaultExpression === "string" || column.defaultExpression === null)
      && (typeof column.generatedExpression === "string" || column.generatedExpression === null)
      && (column.identity === "none" || column.identity === "always" || column.identity === "by-default")
    ));
  });
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rowsFrom(result: { rows: unknown[] }): Record<string, unknown>[] {
  return result.rows as Record<string, unknown>[];
}

async function currentSchemaManifest(tx: Transaction): Promise<BackupSchemaManifest> {
  const result = await tx.execute(sql.raw(`
    SELECT
      c.table_name,
      c.column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS canonical_type,
      NOT a.attnotnull AS nullable,
      c.column_default AS default_expression,
      CASE
        WHEN a.attgenerated = '' THEN NULL
        ELSE pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)
      END AS generated_expression,
      CASE a.attidentity
        WHEN 'a' THEN 'always'
        WHEN 'd' THEN 'by-default'
        ELSE 'none'
      END AS identity
    FROM information_schema.columns c
    JOIN pg_catalog.pg_namespace n
      ON n.nspname = c.table_schema
    JOIN pg_catalog.pg_class cl
      ON cl.relnamespace = n.oid AND cl.relname = c.table_name
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = cl.oid AND a.attname = c.column_name
        AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef ad
      ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE c.table_schema = 'public'
      AND c.table_name IN (${APPLICATION_TABLES.map(quoteLiteral).join(", ")})
    ORDER BY c.table_name, c.ordinal_position
  `));
  const manifest = Object.fromEntries(
    APPLICATION_TABLES.map((table) => [table, [] as BackupColumn[]]),
  ) as BackupSchemaManifest;
  for (const row of rowsFrom(result) as unknown as Array<BackupColumn & {
    table_name: ApplicationTable;
    column_name: string;
    canonical_type: string;
    default_expression: string | null;
    generated_expression: string | null;
  }>) {
    if (manifest[row.table_name]) {
      manifest[row.table_name].push({
        name: row.column_name,
        canonicalType: row.canonical_type,
        nullable: row.nullable,
        defaultExpression: row.default_expression,
        generatedExpression: row.generated_expression,
        identity: row.identity,
      });
    }
  }
  for (const table of APPLICATION_TABLES) {
    if (manifest[table].length === 0) {
      throw new BackupValidationError(`Application table ${table} is unavailable.`);
    }
  }
  return manifest;
}

function validateRowsAgainstSchema(
  document: BackupDocument,
  schemaManifest: BackupSchemaManifest,
): void {
  if (JSON.stringify(document.schemaManifest) !== JSON.stringify(schemaManifest)) {
    throw new BackupValidationError("Backup schema manifest does not match the current database schema.");
  }
  for (const table of APPLICATION_TABLES) {
    const columns = schemaManifest[table].map((column) => column.name);
    for (const row of document.tables[table]) {
      if (!hasExactlyKeys(row, columns)) {
        throw new BackupValidationError(`Backup row has an invalid column set for ${table}.`);
      }
    }
  }
}

function validateBackupInvariants(document: BackupDocument): void {
  const settings = document.tables.nemesys_server_settings;
  if (settings.length !== 1 || settings[0]?.id !== "default") {
    throw new BackupValidationError("Backup must contain exactly one default server-settings row.");
  }
}

export async function createBackup(tx: Transaction): Promise<BackupDocument> {
  const schemaManifest = await currentSchemaManifest(tx);
  const tables = {} as BackupRows;
  for (const table of APPLICATION_TABLES) {
    const result = await tx.execute(sql.raw(`SELECT * FROM public.${quoteIdentifier(table)}`));
    tables[table] = rowsFrom(result);
    // A table that exists but has no columns cannot be a valid application
    // table, and should fail rather than producing an unusable export.
    if (schemaManifest[table].length === 0) {
      throw new BackupValidationError(`Application table ${table} is unavailable.`);
    }
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    schemaManifest,
    tables,
  };
}

async function replaceTable(
  tx: Transaction,
  table: ApplicationTable,
  rows: Record<string, unknown>[],
  columns: BackupColumn[],
): Promise<void> {
  await tx.execute(sql.raw(`DELETE FROM public.${quoteIdentifier(table)}`));
  if (rows.length === 0) return;
  const columnNames = columns.map((column) => column.name);
  const columnSql = columnNames.map(quoteIdentifier).join(", ");
  // jsonb_populate_recordset lets PostgreSQL perform the same type coercion
  // as normal inserts while all values remain query parameters.
  await tx.execute(sql`
    INSERT INTO public.${sql.raw(quoteIdentifier(table))} (${sql.raw(columnSql)})
    SELECT ${sql.join(columnNames.map((column) => sql.raw(`record.${quoteIdentifier(column)}`)), sql`, `)}
    FROM jsonb_populate_recordset(
      NULL::public.${sql.raw(quoteIdentifier(table))},
      ${JSON.stringify(rows)}::jsonb
    ) AS record
  `);
}

export async function repairSequences(tx: Transaction): Promise<void> {
  const result = await tx.execute(sql.raw(`
    SELECT c.table_name, c.column_name, pg_get_serial_sequence(
      format('public.%I', c.table_name), c.column_name
    ) AS sequence_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name IN (${APPLICATION_TABLES.map(quoteLiteral).join(", ")})
      AND (c.column_default LIKE 'nextval(%' OR c.is_identity = 'YES')
  `));
  for (const row of rowsFrom(result) as Array<{ table_name: ApplicationTable; column_name: string; sequence_name: string | null }>) {
    if (!row.sequence_name) continue;
    await tx.execute(sql`
      SELECT setval(
        ${row.sequence_name},
        COALESCE((SELECT MAX(${sql.raw(quoteIdentifier(row.column_name))})::bigint
          FROM public.${sql.raw(quoteIdentifier(row.table_name))}), 1),
        EXISTS (SELECT 1 FROM public.${sql.raw(quoteIdentifier(row.table_name))})
      )
    `);
  }
}

export async function restoreBackup(tx: Transaction, document: BackupDocument): Promise<void> {
  const schemaManifest = await currentSchemaManifest(tx);
  validateRowsAgainstSchema(document, schemaManifest);
  validateBackupInvariants(document);

  // Validate both the live singleton and the security-state singleton before
  // any destructive statement.  The state table is not in the application
  // backup, so an upload can never replace or reset the revocation epoch.
  const invariantResult = await tx.execute(sql.raw(`
    SELECT
      (SELECT COUNT(*)::integer FROM public.nemesys_server_settings) AS settings_count,
      (SELECT COUNT(*)::integer FROM public.nemesys_server_settings WHERE id = 'default') AS default_settings_count,
      (SELECT COUNT(*)::integer FROM public.nemesys_security_state WHERE id = 'default') AS security_state_count
  `));
  const invariants = rowsFrom(invariantResult)[0] as unknown as {
    settings_count?: number | string;
    default_settings_count?: number | string;
    security_state_count?: number | string;
  } | undefined;
  if (
    Number(invariants?.settings_count) !== 1
    || Number(invariants?.default_settings_count) !== 1
    || Number(invariants?.security_state_count) !== 1
  ) {
    throw new BackupValidationError("The database is missing a required singleton.");
  }

  const generationResult = await tx.execute(sql.raw(`
    UPDATE public.nemesys_security_state
    SET admin_session_generation = admin_session_generation + 1
    WHERE id = 'default'
    RETURNING admin_session_generation AS next_generation
  `));
  const nextGeneration = Number(
    (rowsFrom(generationResult)[0] as unknown as { next_generation?: number | string } | undefined)?.next_generation,
  );
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 1) {
    throw new BackupValidationError("The database session security state is invalid.");
  }
  for (const table of DELETE_ORDER) {
    await tx.execute(sql.raw(`DELETE FROM public.${quoteIdentifier(table)}`));
  }
  for (const table of INSERT_ORDER) {
    await replaceTable(tx, table, document.tables[table], schemaManifest[table]);
  }
  await repairSequences(tx);
  // Keep the legacy column synchronized for older tooling, but never read it
  // for authorization or session validation.
  await tx.execute(sql`
    UPDATE public.nemesys_server_settings
    SET admin_session_generation = ${nextGeneration}
    WHERE id = 'default'
  `);
  await tx.execute(sql.raw("DELETE FROM public.nemesys_sessions"));
}
