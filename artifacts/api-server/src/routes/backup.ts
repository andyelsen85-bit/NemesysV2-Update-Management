import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import {
  DownloadAdminBackupResponse,
  RestoreAdminBackupResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "./auth";
import { destroyApplicationSession, SESSION_COOKIE } from "../lib/session";
import {
  MAX_BACKUP_BYTES,
  BACKUP_FORMAT_VERSION,
  createBackup,
  restoreBackup,
  validateBackupDocument,
  BackupValidationError,
} from "../lib/backup";
import { MulterError } from "multer";

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BACKUP_BYTES, files: 1 },
});

function backupFile(req: Request): Express.Multer.File | null {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const candidates = [files?.file?.[0], files?.backup?.[0]].filter(
    (file): file is Express.Multer.File => Boolean(file),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

router.get("/admin/backup", requireAdmin, async (req, res): Promise<void> => {
  const backup = await db.transaction(
    async (tx) => createBackup(tx),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const response = DownloadAdminBackupResponse.parse(backup);
  const filename = `nemesys-backup-v${BACKUP_FORMAT_VERSION}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // Serialize only the validated export; never log its contents.
  res.send(JSON.stringify(response));
});

router.post(
  "/admin/restore",
  requireAdmin,
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "backup", maxCount: 1 },
  ]),
  (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof MulterError) {
      res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? `Backup file must be no larger than ${MAX_BACKUP_BYTES} bytes.`
          : "A single backup JSON file is required.",
      });
      return;
    }
    if (error) {
      next(error);
      return;
    }
    next();
  },
  async (req: Request, res: Response): Promise<void> => {
    const file = backupFile(req);
    if (!file) {
      res.status(400).json({ error: "A single backup JSON file is required." });
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(file.buffer.toString("utf8"));
    } catch {
      res.status(400).json({ error: "The backup file is not valid JSON." });
      return;
    }
    if (!validateBackupDocument(document)) {
      res.status(400).json({
        error: "The backup format, version, table set, or row shapes are invalid.",
      });
      return;
    }
    try {
      await db.transaction(
        async (tx) => restoreBackup(tx, document),
        { isolationLevel: "serializable" },
      );
    } catch (error) {
      if (error instanceof BackupValidationError) {
        res.status(400).json({
          error: "The backup is not compatible with this installation.",
        });
        return;
      }
      throw error;
    }
    // The restore transaction removes every session row. Destroying this
    // request's in-memory session as well prevents express-session's response
    // finalizer from touching it back into the store.
    await destroyApplicationSession(req);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
    res.json(RestoreAdminBackupResponse.parse({ restored: true }));
  },
);

export default router;