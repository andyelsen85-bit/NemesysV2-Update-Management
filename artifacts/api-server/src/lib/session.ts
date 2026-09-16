import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { db, pool, securityStateTable } from "@workspace/db";
import { eq, sql, type SQL } from "drizzle-orm";

export const SESSION_COOKIE = "nemesys_session";
export const SESSION_IDLE_TIMEOUT_SECONDS = 8 * 60 * 60;

const PgSession = connectPgSimple(session);

declare module "express-session" {
  interface SessionData {
    adminUsername?: string;
    adminAuthSource?: "local" | "ldap" | "adfs";
    mustChangePassword?: boolean;
    createdAt?: number;
    adminSessionGeneration?: number;
  }
}

function requiredSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for administrator sessions.");
  return secret;
}

export function absoluteSessionTimeoutSeconds(): number {
  const configured = Number(
    process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS
      ?? process.env.SESSION_ABSOLUTE_TTL_SECONDS
      ?? 24 * 60 * 60,
  );
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 24 * 60 * 60;
}

export function createApplicationSessionMiddleware() {
  const store = new PgSession({
    pool,
    tableName: "nemesys_sessions",
    createTableIfMissing: false,
  });
  // A request can have loaded a session before an administrator restore
  // advances the generation.  Do not allow express-session's response
  // finalizer to resurrect that stale row.
  const originalSet = store.set.bind(store);
  store.set = ((sid: string, sess: session.SessionData, callback: (error?: any) => void) => {
    if (typeof sess.adminUsername !== "string" || sess.adminSessionGeneration === undefined) {
      originalSet(sid, sess, callback);
      return;
    }
    void pool.query(
      `SELECT admin_session_generation FROM public.nemesys_security_state WHERE id = 'default'`,
    ).then(async ({ rows }) => {
      if (rows.length !== 1) {
        throw new Error("Administrator session security state is unavailable.");
      }
      const generation = Number(rows[0]?.admin_session_generation);
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("Administrator session security state is invalid.");
      }
      if (generation !== Number(sess.adminSessionGeneration)) {
        await pool.query("DELETE FROM public.nemesys_sessions WHERE sid = $1", [sid]);
        callback();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        originalSet(sid, sess, (error) => error ? reject(error) : resolve());
      });
      callback();
    }).catch(callback);
  }) as typeof store.set;
  return session({
    name: SESSION_COOKIE,
    secret: requiredSessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_IDLE_TIMEOUT_SECONDS * 1000,
      path: "/",
    },
  });
}

export async function getAdminSessionGeneration(): Promise<number> {
  const [state] = await db.select({
    generation: securityStateTable.adminSessionGeneration,
  }).from(securityStateTable).where(eq(securityStateTable.id, "default")).limit(1);
  const generation = Number(state?.generation);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Administrator session security state is unavailable.");
  }
  return generation;
}

type SessionExecutor = { execute: (query: SQL) => Promise<unknown> };

/** Delete only directory-backed administrator sessions; local admin sessions remain intact. */
export async function revokeDirectoryAdminSessions(
  executor: SessionExecutor,
  username: string,
): Promise<void> {
  await executor.execute(sql`
    DELETE FROM public.nemesys_sessions
    WHERE sess ->> 'adminUsername' = ${username}
      AND sess ->> 'adminAuthSource' IN ('ldap', 'adfs')
  `);
}

export function destroyApplicationSession(req: import("express").Request): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
}