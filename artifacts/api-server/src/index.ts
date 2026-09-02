import { logger } from "./lib/logger";
import { ensureSeedData } from "./lib/seed";
import { startRuntimeServer } from "./runtime-server";

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

await ensureSeedData();

try {
  await startRuntimeServer(port);
} catch (error) {
  logger.error({ err: error }, "Error listening on port");
  process.exit(1);
}
