#!/usr/bin/env node
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import { CompanionBroker } from "./broker.mjs";
import { resolveBrokerSocketPath } from "../shared/paths.mjs";
import { ensureBrokerSecret } from "../shared/security.mjs";
import { ensureIssuerSecret } from "../shared/task-runtime.mjs";

async function socketIsLive(socketPath) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function prepareSocket(socketPath) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    }
    if (await socketIsLive(socketPath)) {
      const error = new Error("AOS Chrome Companion broker is already running");
      error.code = "BROKER_ALREADY_RUNNING";
      throw error;
    }
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

const socketPath = resolveBrokerSocketPath();
await prepareSocket(socketPath);
const secret = await ensureBrokerSecret();
const issuerSecrets = {
  aos: await ensureIssuerSecret("aos"),
  codex_mcp: await ensureIssuerSecret("codex_mcp"),
};
const broker = new CompanionBroker({ socketPath, secret, issuerSecrets });
await broker.listen();
await chmod(socketPath, 0o600);
process.stderr.write(`AOS Chrome Companion broker listening at ${socketPath}\n`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await broker.close();
  try {
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  process.exit(0);
}

// A local installer stamps the new Extension before swapping the app. If an
// old resident broker receives that hello first, it cannot enforce the new
// protocol safely. Close this process so the Native Messaging relay's normal
// reconnect/autoStart path launches the current broker instead of leaving the
// profile in a permanent build-mismatch loop.
broker.on("build.mismatch", () => {
  setImmediate(() => { void shutdown(); });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
