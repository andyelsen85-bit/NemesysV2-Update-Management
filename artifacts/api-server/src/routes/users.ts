import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { adminUsersTable, db } from "@workspace/db";
import { requireAdmin } from "./auth";
import { lookupLdapUser } from "../lib/ldap";
import { revokeDirectoryAdminSessions } from "../lib/session";

const router: IRouter = Router();

function userDto(user: typeof adminUsersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    source: "ldap" as const,
    directoryDn: user.directoryDn,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

router.get("/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(adminUsersTable)
    .where(eq(adminUsersTable.source, "ldap"))
    .orderBy(desc(adminUsersTable.createdAt));
  res.json(users.map(userDto));
});

router.post("/users", requireAdmin, async (req, res): Promise<void> => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) {
    res.status(400).json({ error: "LDAP username is required." });
    return;
  }
  const lookup = await lookupLdapUser(username);
  if (!lookup.user) {
    res.status(400).json({ error: lookup.diagnostic.message, stage: lookup.diagnostic.stage });
    return;
  }
  const [existing] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, lookup.user.username)).limit(1);
  if (existing) {
    if (existing.source === "local") {
      res.status(403).json({ error: "The local administrator account cannot be managed here." });
      return;
    }
    res.status(409).json({ error: "That administrator already exists." });
    return;
  }
  const [created] = await db.insert(adminUsersTable).values({
    id: `admin-${randomUUID()}`,
    username: lookup.user.username,
    displayName: lookup.user.displayName,
    email: lookup.user.email,
    source: "ldap",
    directoryDn: lookup.user.directoryDn,
    isActive: true,
  }).returning();
  res.status(201).json(userDto(created));
});

router.patch("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const isActive = req.body?.isActive;
  if (typeof isActive !== "boolean") {
    res.status(400).json({ error: "isActive must be boolean." });
    return;
  }
  const [existing] = await db.select({ source: adminUsersTable.source })
    .from(adminUsersTable).where(eq(adminUsersTable.id, String(req.params.id))).limit(1);
  if (existing?.source === "local") {
    res.status(403).json({ error: "The local administrator account cannot be managed here." });
    return;
  }
  const updated = await db.transaction(async (transaction) => {
    const [row] = await transaction.update(adminUsersTable)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(adminUsersTable.id, String(req.params.id))).returning();
    if (row && !isActive) await revokeDirectoryAdminSessions(transaction, row.username);
    return row;
  });
  if (!updated) {
    res.status(404).json({ error: "Administrator not found." });
    return;
  }
  res.json(userDto(updated));
});

router.delete("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const [existing] = await db.select({ source: adminUsersTable.source })
    .from(adminUsersTable).where(eq(adminUsersTable.id, String(req.params.id))).limit(1);
  if (existing?.source === "local") {
    res.status(403).json({ error: "The local administrator account cannot be managed here." });
    return;
  }
  const deleted = await db.transaction(async (transaction) => {
    const [row] = await transaction.delete(adminUsersTable)
      .where(eq(adminUsersTable.id, String(req.params.id))).returning();
    if (row) await revokeDirectoryAdminSessions(transaction, row.username);
    return row;
  });
  if (!deleted) {
    res.status(404).json({ error: "Administrator not found." });
    return;
  }
  res.status(204).end();
});

export default router;