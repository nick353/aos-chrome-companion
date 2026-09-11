import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../shared/constants.mjs";
import { CompanionError } from "../shared/errors.mjs";
import { JsonLineDecoder, writeJsonLine } from "../shared/framing.mjs";
import { resolveBrokerSocketPath } from "../shared/paths.mjs";
import { ensureBrokerSecret } from "../shared/security.mjs";

const BROKER_ENTRY = fileURLToPath(new URL("../broker/main.mjs", import.meta.url));
const BROKER_STARTUP_TIMEOUT_MS = 12_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(socketPath, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CompanionError("broker_connect_timeout", "Timed out connecting to Companion broker"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function ensureBroker(socketPath) {
  try {
    return await openSocket(socketPath);
  } catch (initialError) {
    const child = spawn(process.execPath, [BROKER_ENTRY], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    let lastError = initialError;
    const deadline = Date.now() + BROKER_STARTUP_TIMEOUT_MS;
    let attempts = 0;
    for (; attempts < 40 && Date.now() < deadline; attempts += 1) {
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      try {
        return await openSocket(socketPath, Math.min(1_000, Math.max(100, deadline - Date.now())));
      } catch (error) {
        lastError = error;
      }
    }
    throw new CompanionError(
      "broker_unavailable",
      "Unable to start or connect to Companion broker",
      { cause: lastError?.message, attempts, startupTimeoutMs: BROKER_STARTUP_TIMEOUT_MS },
    );
  }
}

export async function connectPeer({ role, autoStart = true, env = process.env }) {
  const socketPath = resolveBrokerSocketPath(env);
  const secret = await ensureBrokerSecret(env);
  const socket = autoStart ? await ensureBroker(socketPath) : await openSocket(socketPath);
  socket.setNoDelay(true);
  const decoder = new JsonLineDecoder();
  const listeners = new Set();
  const closeListeners = new Set();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const authTimer = setTimeout(() => {
    readyReject(new CompanionError("broker_auth_timeout", "Broker did not acknowledge peer authentication"));
    socket.destroy();
  }, 3_000);
  authTimer.unref();

  socket.on("data", (chunk) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (message.kind === "peer.ready") {
          clearTimeout(authTimer);
          readyResolve(message);
          continue;
        }
        if (message.kind === "peer.error" && !message.id) {
          for (const listener of listeners) listener(message);
          continue;
        }
        for (const listener of listeners) listener(message);
      }
    } catch (error) {
      readyReject(error);
      socket.destroy();
    }
  });
  socket.on("error", (error) => {
    readyReject(error);
  });
  socket.on("close", () => {
    clearTimeout(authTimer);
    for (const listener of closeListeners) listener();
  });
  writeJsonLine(socket, {
    kind: "peer.hello",
    role,
    auth: secret,
    protocolVersion: PROTOCOL_VERSION,
  });
  await ready;

  return {
    socket,
    send(message) {
      writeJsonLine(socket, message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      socket.end();
    },
  };
}
