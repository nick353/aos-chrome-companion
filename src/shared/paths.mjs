import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDataDir(env = process.env) {
  return env.AOS_CHROME_COMPANION_DATA_DIR
    ?? join(homedir(), "Library", "Application Support", "AOS Chrome Companion");
}

export function resolveBrokerSocketPath(env = process.env) {
  return env.AOS_CHROME_COMPANION_SOCKET
    ?? join(resolveDataDir(env), "broker.sock");
}

export function resolveSecretPath(env = process.env) {
  return env.AOS_CHROME_COMPANION_SECRET_FILE
    ?? join(resolveDataDir(env), "broker-secret");
}

export function resolveStatePath(env = process.env) {
  return env.AOS_CHROME_COMPANION_STATE_FILE
    ?? join(resolveDataDir(env), "broker-state.json");
}

