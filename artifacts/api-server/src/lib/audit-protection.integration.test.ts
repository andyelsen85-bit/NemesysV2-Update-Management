import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/nemesys";

const runDatabaseSecurityTests = process.env.NEMESYS_RUN_DB_SECURITY_TESTS === "1";
const securityDescribe = runDatabaseSecurityTests ? describe : describe.skip;

securityDescribe("PostgreSQL audit mutation protection", () => {
  type TestPool = typeof import("@workspace/db").pool;
  type TestClient = {
    query: (statement: string, values?: unknown[]) => Promise<{
      rowCount: number | null;
    }>;
    release: () => void;
  };
  let client: TestClient;
  let pool: TestPool;
  let ensureDatabaseSchema: typeof import("@workspace/db").ensureDatabaseSchema;
  const auditId = `audit-protection-${randomUUID()}`;
  const clientId = `audit-protection-client-${randomUUID()}`;

  beforeAll(async () => {
    ({ pool, ensureDatabaseSchema } = await import("@workspace/db"));
    await ensureDatabaseSchema();
    client = await pool.connect() as unknown as TestClient;
    await client.query("BEGIN");
    await client.query("CREATE ROLE nemesys_audit_test_runtime NOLOGIN");
    await client.query("GRANT nemesys_app TO nemesys_audit_test_runtime");
    await client.query("SET LOCAL ROLE nemesys_audit_test_runtime");
    await client.query(
      `SELECT public.nemesys_replace_latest_audit_report(
        $1, $2, 'Audit protection test', now(), 'success', '[]'::jsonb
      )`,
      [auditId, clientId],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    if (pool) await pool.end();
  });

  async function expectRejectedMutation(statement: string): Promise<void> {
    await client.query("SAVEPOINT before_forbidden_mutation");
    await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT before_forbidden_mutation");
  }

  it("rejects direct UPDATE, DELETE, and TRUNCATE statements", async () => {
    const privileges = await client.query(
      `SELECT
        has_table_privilege(current_user, 'public.nemesys_audit_entries', 'SELECT') AS can_select,
        has_table_privilege(current_user, 'public.nemesys_audit_entries', 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'public.nemesys_audit_entries', 'DELETE') AS can_delete,
        has_table_privilege(current_user, 'public.nemesys_audit_entries', 'TRUNCATE') AS can_truncate`,
    ) as unknown as { rows: Array<Record<string, boolean>> };
    expect(privileges.rows[0]).toMatchObject({
      can_select: true,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });
    await expectRejectedMutation(
      `UPDATE public.nemesys_audit_entries SET result = 'warning' WHERE id = '${auditId}'`,
    );
    await expectRejectedMutation(
      `DELETE FROM public.nemesys_audit_entries WHERE id = '${auditId}'`,
    );
    await expectRejectedMutation("TRUNCATE TABLE public.nemesys_audit_entries");
  });

  it("allows only the trusted privilege-separated mutation routine", async () => {
    await client.query("SAVEPOINT before_trusted_mutation");
    const result = await client.query(
      "SELECT public.nemesys_delete_inactive_audits($1::text[])",
      [[clientId]],
    );
    expect(result.rowCount).toBe(1);
    await client.query("ROLLBACK TO SAVEPOINT before_trusted_mutation");
  });
});