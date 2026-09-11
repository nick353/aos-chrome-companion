import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveSecretPath } from "./paths.mjs";

export async function ensureBrokerSecret(env = process.env) {
  const secretPath = resolveSecretPath(env);
  await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(secretPath, "wx", 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  return (await readFile(secretPath, "utf8")).trim();
}

export function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

