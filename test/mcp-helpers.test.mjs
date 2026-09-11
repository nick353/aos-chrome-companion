import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeUploadParams, materializeUploadMultipleParams, MAX_UPLOAD_BYTES } from "../src/mcp/action-materializer.mjs";
import { bindCodexTaskId, McpTaskBindingRegistry, resolveCodexTaskId } from "../src/mcp/task-context.mjs";
import { authorizedTransactionPayload } from "../src/shared/task-runtime.mjs";

test("authorized transaction payload uses one shared canonical projection", () => {
  const params = {
    startUrl: "https://example.test/apply",
    allowedOrigins: ["https://example.test"],
    actions: [{ method: "page.type", params: { locator: { label: "Name" }, text: "N" } }],
    reuseTaskTab: true,
    keepTaskTab: true,
    retainOnUnknown: true,
    capsule: { workflowType: "Jobs", targetKey: "jobs:example" },
  };
  assert.deepEqual(authorizedTransactionPayload(params), {
    startUrl: params.startUrl,
    allowedOrigins: params.allowedOrigins,
    actions: params.actions,
    reuseTaskTab: true,
    keepTaskTab: true,
    retainOnUnknown: true,
    precondition: null,
    capsule: params.capsule,
  });
  assert.equal(authorizedTransactionPayload({}).keepTaskTab, null);
  assert.equal(authorizedTransactionPayload({}).capsule, null);
  assert.equal(authorizedTransactionPayload({}).precondition, null);
  assert.equal(authorizedTransactionPayload({ tabId: 7 }).tabId, 7);
  assert.notDeepEqual(authorizedTransactionPayload({ tabId: 7 }), authorizedTransactionPayload({ tabId: 8 }), "the signed target must change when tabId changes");
});

test("Codex task binding uses ambient task identity and rejects caller forgery", () => {
  const env = { CODEX_THREAD_ID: "thread-real", CODEX_SESSION_ID: "session-fallback" };
  assert.equal(resolveCodexTaskId(env), "thread-real");
  assert.equal(bindCodexTaskId(undefined, env), "thread-real");
  assert.equal(bindCodexTaskId("thread-real", env), "thread-real");
  assert.throws(() => bindCodexTaskId("thread-forged", env), (error) => error.code === "task_id_mismatch");
  assert.throws(() => bindCodexTaskId(undefined, {}), (error) => error.code === "codex_thread_identity_unavailable");
});

test("Codex task binding accepts host MCP metadata and fails closed on conflicts", () => {
  const forms = [
    [{ "openai/threadId": "thread-openai-slash" }, "thread-openai-slash"],
    [{ "openai/thread_id": "thread-openai-underscore" }, "thread-openai-underscore"],
    [{ codexThreadId: "thread-codex-camel" }, "thread-codex-camel"],
    [{ codex_thread_id: "thread-codex-underscore" }, "thread-codex-underscore"],
    [{ threadId: "thread-camel" }, "thread-camel"],
    [{ thread_id: "thread-underscore" }, "thread-underscore"],
    [{ thread: { id: "thread-nested" } }, "thread-nested"],
    [{ "x-codex-turn-metadata": { thread_id: "thread-turn-object" } }, "thread-turn-object"],
    [{ "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-turn-json" }) }, "thread-turn-json"],
    [{ "codex-app-tools": { "openai/threadId": "thread-wrapped-openai" } }, "thread-wrapped-openai"],
    [{ "codex/app_tools": { thread: { id: "thread-wrapped-nested" } } }, "thread-wrapped-nested"],
  ];
  for (const [form, expected] of forms) {
    assert.equal(resolveCodexTaskId({}, { _meta: form }), expected);
  }
  const extra = { _meta: { "x-codex-turn-metadata": { thread_id: "thread-host" } } };
  assert.equal(bindCodexTaskId("thread-host", {}, extra), "thread-host");
  assert.throws(
    () => bindCodexTaskId(undefined, { CODEX_THREAD_ID: "thread-env" }, extra),
    (error) => error.code === "codex_thread_identity_conflict",
  );
  assert.throws(
    () => bindCodexTaskId(undefined, {}, { _meta: { thread_id: "thread-a", "x-codex-turn-metadata": { thread_id: "thread-b" } } }),
    (error) => error.code === "codex_thread_identity_conflict",
  );
  assert.throws(
    () => bindCodexTaskId("thread-other", {}, extra),
    (error) => error.code === "task_id_mismatch",
  );
  assert.throws(
    () => bindCodexTaskId(undefined, {}, { _meta: { taskId: "caller-value" } }),
    (error) => error.code === "codex_thread_identity_unavailable",
  );
  assert.throws(
    () => bindCodexTaskId(undefined, {}, { _meta: { "codex-app-tools": { taskId: "caller-value" } } }),
    (error) => error.code === "codex_thread_identity_unavailable",
  );
  assert.throws(
    () => bindCodexTaskId(undefined, {}, { _meta: { "io.modelcontextprotocol/related-task": { taskId: "related-task" } } }),
    (error) => error.code === "codex_thread_identity_unavailable",
  );
});

test("MCP task bindings reject cross-task session and lease use", () => {
  const bindings = new McpTaskBindingRegistry();
  bindings.bindSession("session-a", "task-a");
  bindings.bindLease("lease-a", "session-a", "task-a");
  bindings.assertSession("session-a", "task-a");
  bindings.assertLease("lease-a", "session-a", "task-a");
  assert.throws(() => bindings.assertSession("session-a", "task-b"), (error) => error.code === "mcp_session_task_mismatch");
  assert.throws(() => bindings.assertLease("lease-a", "session-a", "task-b"), (error) => error.code === "mcp_session_task_mismatch");
  assert.throws(() => bindings.assertLease("lease-a", "session-b", "task-a"), (error) => error.code === "mcp_session_task_binding_missing");
  assert.throws(() => bindings.assertLease("lease-b", "session-a", "task-a"), (error) => error.code === "mcp_lease_task_binding_missing");
  bindings.forgetSession("session-a");
  assert.throws(() => bindings.assertSession("session-a", "task-a"), (error) => error.code === "mcp_session_task_binding_missing");
  assert.throws(() => bindings.assertLease("lease-a", "session-a", "task-a"), (error) => error.code === "mcp_session_task_binding_missing");
});

test("upload materialization accepts bounded regular files and rejects symlinks and oversize files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aos-upload-test-"));
  const filePath = join(directory, "resume.pdf");
  const linkPath = join(directory, "linked.pdf");
  const largePath = join(directory, "large.pdf");
  await writeFile(filePath, "%PDF synthetic");
  await symlink(filePath, linkPath);
  await writeFile(largePath, Buffer.alloc(MAX_UPLOAD_BYTES + 1));
  const params = await materializeUploadParams({ filePath, locator: { label: "Resume" } });
  assert.equal(params.file.name, "resume.pdf");
  assert.equal(params.file.mimeType, "application/pdf");
  assert.equal(params.file.size, 14);
  assert.match(params.file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(params.file.dataBase64, "base64").toString(), "%PDF synthetic");
  await assert.rejects(materializeUploadParams({ filePath: linkPath, locator: { label: "Resume" } }), (error) => error.code === "upload_regular_file_required");
  await assert.rejects(materializeUploadParams({ filePath: largePath, locator: { label: "Resume" } }), (error) => error.code === "upload_file_too_large");
  await rm(directory, { recursive: true, force: true });
});

test("upload accepts a file above the old 512 KiB limit and bounds combined file bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aos-upload-large-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "履歴書.pdf");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 131);
  await writeFile(filePath, bytes);
  const materialized = await materializeUploadParams({ filePath });
  assert.deepEqual(Buffer.from(materialized.file.dataBase64, "base64"), bytes);
  assert.equal(materialized.file.name, "履歴書.pdf");
  const largePath = join(directory, "large.pdf");
  await writeFile(largePath, Buffer.alloc(Math.ceil(MAX_UPLOAD_BYTES / 2) + 1));
  await assert.rejects(materializeUploadMultipleParams({ filePaths: [largePath, largePath] }), { code: "upload_total_too_large" });
});
