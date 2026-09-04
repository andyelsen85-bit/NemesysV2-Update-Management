import { logger } from "./lib/logger";
import { ensureSeedData } from "./lib/seed";
import { ensureDatabaseSchema } from "@workspace/db";
import { startRuntimeServer } from "./runtime-server";
import { materializeTlsCredentials } from "./lib/ssl";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

try {
  await ensureDatabaseSchema();
  await ensureSeedData();
  await materializeTlsCredentials();
} catch (error) {
  const hasMissingRelation = (value: unknown): boolean => {
    let current = value;
    while (current && typeof current === "object") {
      if ("code" in current && current.code === "42P01") return true;
      current = "cause" in current ? current.cause : undefined;
    }
    return false;
  };

  if (hasMissingRelation(error)) {
    logger.fatal(
      { err: error },
      "PostgreSQL is reachable but automatic Nemesys schema initialization failed. Check database permissions and connectivity.",
    );
  } else {
    logger.fatal(
      { err: error },
      "Unable to initialize the Nemesys database schema and seed data",
    );
  }
  process.exit(1);
}

try {
  await startRuntimeServer(port);
} catch (error) {
  logger.error({ err: error }, "Error listening on port");
  process.exit(1);
}
