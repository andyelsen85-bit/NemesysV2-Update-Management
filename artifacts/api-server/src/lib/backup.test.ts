import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_TABLES,
  BACKUP_FORMAT_VERSION,
  DELETE_ORDER,
  INSERT_ORDER,
  OPERATIONAL_TABLE_EXCLUSIONS,
  assertBackupTableCoverage,
  repairSequences,
  restoreBackup,
  validateBackupDocument,
} from "./backup";

function validDocument(): Record<string, unknown> {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    generatedAt: "2026-01-01T00:00:00.000Z",
    schemaManifest: Object.fromEntries(APPLICATION_TABLES.map((table) => [table, []])),
    tables: Object.fromEntries(APPLICATION_TABLES.map((table) => [table, []])),
  };
}

describe("application backup validation", () => {
  it("classifies every operational table and rejects unclassified drift", () => {
    expect(OPERATIONAL_TABLE_EXCLUSIONS.map(({ table }) => table)).toEqual([
      "nemesys_sessions",
      "nemesys_security_state",
      "nemesys_security_buckets",
    ]);
    expect(() => assertBackupTableCoverage([
      ...APPLICATION_TABLES,
      ...OPERATIONAL_TABLE_EXCLUSIONS.map(({ table }) => table),
    ])).not.toThrow();
    expect(() => assertBackupTableCoverage(["nemesys_future_table"]))
      .toThrow(/unclassified/i);
  });

  it("requires the supported version and exact application table set", () => {
    expect(validateBackupDocument(validDocument())).toBe(true);

    const wrongVersion = { ...validDocument(), formatVersion: 1 };
    expect(validateBackupDocument(wrongVersion)).toBe(false);

    const extraTable = validDocument();
    (extraTable.tables as Record<string, unknown>).unexpected = [];
    expect(validateBackupDocument(extraTable)).toBe(false);

    const missingManifest = validDocument();
    delete missingManifest.schemaManifest;
    expect(validateBackupDocument(missingManifest)).toBe(false);
  });

  it("requires each table value to be an array of row objects", () => {
    const invalid = validDocument();
    (invalid.tables as Record<string, unknown>)[APPLICATION_TABLES[0]] = [{}];
    expect(validateBackupDocument(invalid)).toBe(true);

    (invalid.tables as Record<string, unknown>)[APPLICATION_TABLES[0]] = [null];
    expect(validateBackupDocument(invalid)).toBe(false);
    (invalid.tables as Record<string, unknown>)[APPLICATION_TABLES[0]] = {};
    expect(validateBackupDocument(invalid)).toBe(false);
  });
});

describe("application restore validation", () => {
  function documentWithSettingsRows(rows: Record<string, unknown>[]): Record<string, unknown> {
    const manifestColumn = {
      name: "id",
      canonicalType: "text",
      nullable: false,
      defaultExpression: null,
      generatedExpression: null,
      identity: "none",
    };
    return {
      ...validDocument(),
      schemaManifest: Object.fromEntries(
        APPLICATION_TABLES.map((table) => [table, [manifestColumn]]),
      ),
      tables: Object.fromEntries(APPLICATION_TABLES.map((table) => [
        table,
        table === "nemesys_server_settings" ? rows : [],
      ])),
    };
  }

  it.each([
    ["empty", []],
    ["missing", [{ id: null }]],
    ["wrong", [{ id: "not-default" }]],
  ])("rejects %s default settings backups before issuing a delete", async (_label, rows) => {
    const document = documentWithSettingsRows(rows);
    const execute = vi.fn(async () => ({
      rows: APPLICATION_TABLES.map((table) => ({
        table_name: table,
        column_name: "id",
        canonical_type: "text",
        nullable: false,
        default_expression: null,
        generated_expression: null,
        identity: "none",
      })),
    }));

    await expect(restoreBackup({ execute }, document as never)).rejects.toThrow(/default server-settings/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects an incompatible empty-table backup before issuing a delete", async () => {
    const manifestColumn = {
      name: "id",
      canonicalType: "integer",
      nullable: false,
      defaultExpression: null,
      generatedExpression: null,
      identity: "none",
    };
    const currentManifest = Object.fromEntries(
      APPLICATION_TABLES.map((table) => [table, [manifestColumn]]),
    );
    const document = validDocument();
    document.schemaManifest = currentManifest;
    const incompatible = {
      ...document,
      schemaManifest: Object.fromEntries(APPLICATION_TABLES.map((table) => [table, []])),
    };
    const execute = vi.fn(async () => ({ rows: APPLICATION_TABLES.map((table) => ({
      table_name: table,
      column_name: "id",
      canonical_type: "integer",
      nullable: false,
      default_expression: null,
      generated_expression: null,
      identity: "none",
    })) }));
    const tx = { execute };

    await expect(restoreBackup(tx, incompatible as never)).rejects.toThrow(/schema manifest/i);
    // Schema discovery is the only statement allowed before validation.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects row column mismatches before issuing a delete", async () => {
    const manifestColumn = {
      name: "id",
      canonicalType: "integer",
      nullable: false,
      defaultExpression: null,
      generatedExpression: null,
      identity: "none",
    };
    const schemaManifest = Object.fromEntries(
      APPLICATION_TABLES.map((table) => [table, [manifestColumn]]),
    );
    const document = {
      ...validDocument(),
      schemaManifest,
      tables: Object.fromEntries(APPLICATION_TABLES.map((table) => [
        table,
        table === APPLICATION_TABLES[0] ? [{ wrong: 1 }] : [],
      ])),
    };
    const execute = vi.fn(async () => ({ rows: APPLICATION_TABLES.map((table) => ({
      table_name: table,
      column_name: "id",
      canonical_type: "integer",
      nullable: false,
      default_expression: null,
      generated_expression: null,
      identity: "none",
    })) }));

    await expect(restoreBackup({ execute }, document as never)).rejects.toThrow(/column set/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("increments the live security generation instead of restoring backup state", async () => {
    const document = documentWithSettingsRows([{ id: "default" }]);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: APPLICATION_TABLES.map((table) => ({
          table_name: table,
          column_name: "id",
          canonical_type: "text",
          nullable: false,
          default_expression: null,
          generated_expression: null,
          identity: "none",
        })),
      })
      .mockResolvedValueOnce({
        rows: [{
          settings_count: 1,
          default_settings_count: 1,
          security_state_count: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ next_generation: 42 }] })
      .mockResolvedValue({ rows: [] });

    await restoreBackup({ execute }, document as never);
    // The generation statement is an atomic increment of the live row; it
    // never takes a value from the uploaded server-settings row.
    expect(JSON.stringify(execute.mock.calls[2][0])).toMatch(/admin_session_generation.*\+ 1/);
  });
});

describe("application restore ordering", () => {
  it("deletes relationship rows before their referenced rows", () => {
    expect(DELETE_ORDER.indexOf("nemesys_directory_computer_groups"))
      .toBeLessThan(DELETE_ORDER.indexOf("nemesys_directory_computers"));
    expect(DELETE_ORDER.indexOf("nemesys_software_policy_target_groups"))
      .toBeLessThan(DELETE_ORDER.indexOf("nemesys_software_policies"));
    expect(DELETE_ORDER.indexOf("nemesys_adfs_identity_mappings"))
      .toBeLessThan(DELETE_ORDER.indexOf("nemesys_admin_users"));
  });

  it("inserts relationship rows after their referenced rows", () => {
    expect(INSERT_ORDER.indexOf("nemesys_directory_computer_groups"))
      .toBeGreaterThan(INSERT_ORDER.indexOf("nemesys_directory_computers"));
    expect(INSERT_ORDER.indexOf("nemesys_software_policy_target_groups"))
      .toBeGreaterThan(INSERT_ORDER.indexOf("nemesys_software_policies"));
    expect(INSERT_ORDER.indexOf("nemesys_adfs_identity_mappings"))
      .toBeGreaterThan(INSERT_ORDER.indexOf("nemesys_admin_users"));
  });

  it("repairs every discovered sequence, including identity columns", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          table_name: "nemesys_clients",
          column_name: "id",
          sequence_name: "public.nemesys_clients_id_seq",
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await repairSequences({ execute });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});