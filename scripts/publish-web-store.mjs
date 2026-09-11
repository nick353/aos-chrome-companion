#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

export function parseWebStoreArgs(argv) {
  const args = { publish: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--zip") args.zip = argv[++index];
    else if (argv[index] === "--publisher-id") args.publisherId = argv[++index];
    else if (argv[index] === "--extension-id") args.extensionId = argv[++index];
    else if (argv[index] === "--publish") args.publish = true;
    else fail("web_store_argument_invalid", `Unknown argument: ${argv[index]}`);
  }
  if (!args.zip || !args.publisherId || !args.extensionId) fail("web_store_arguments_required", "--zip, --publisher-id, and --extension-id are required");
  if (!/^[a-p]{32}$/u.test(args.extensionId)) fail("web_store_extension_id_invalid", "Invalid Chrome Extension ID");
  return args;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) fail(`web_store_http_${response.status}`, `Chrome Web Store API request failed (${response.status})`);
  return body;
}

export async function publishWebStore(args, env = process.env) {
  const token = String(env.CHROME_WEB_STORE_ACCESS_TOKEN || "").trim();
  if (!token) fail("chrome_web_store_access_token_missing", "Set CHROME_WEB_STORE_ACCESS_TOKEN in the environment; never pass it on the command line");
  const zip = await readFile(resolve(args.zip));
  const item = `publishers/${encodeURIComponent(args.publisherId)}/items/${args.extensionId}`;
  const upload = await requestJson(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
    body: zip,
  });
  let publish = null;
  if (args.publish) {
    publish = await requestJson(`https://chromewebstore.googleapis.com/v2/${item}:publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  return {
    ok: true,
    schema: "aos_chrome_companion_web_store_receipt.v1",
    extension_id: args.extensionId,
    publisher_id: args.publisherId,
    uploaded: true,
    upload_state: upload?.uploadState || null,
    publish_requested: args.publish,
    publish_status: publish?.status || null,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.stdout.write(`${JSON.stringify(await publishWebStore(parseWebStoreArgs(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, exact_blocker: error?.code || "web_store_publish_failed", message: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  }
}
