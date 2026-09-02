import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import app from "./app";
import { getActiveTlsCredentials } from "./lib/ssl";
import { logger } from "./lib/logger";

let runtimeServer: Server | null = null;
let runtimePort = 0;

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function startRuntimeServer(port: number): Promise<void> {
  runtimePort = port;
  const tls = await getActiveTlsCredentials();
  runtimeServer = tls ? createHttpsServer(tls, app) : createHttpServer(app);
  await listen(runtimeServer, port);
  logger.info({ port, protocol: tls ? "https" : "http" }, "Server listening");
}

export async function reloadRuntimeServer(): Promise<void> {
  if (!runtimeServer || !runtimePort) return;
  const previous = runtimeServer;
  await new Promise<void>((resolve) => previous.close(() => resolve()));
  runtimeServer = null;
  await startRuntimeServer(runtimePort);
}