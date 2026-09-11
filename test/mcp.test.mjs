import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { PROTOCOL_VERSION, DEFAULT_CAPABILITIES } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";

function onceMessage(peer, predicate) {
  return new Promise((resolve) => {
    const remove = peer.onMessage((message) => {
      if (predicate(message)) {
        remove();
        resolve(message);
      }
    });
  });
}

test("MCP server initializes, lists Companion tools, and reads broker status", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-mcp-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    CODEX_THREAD_ID: "01test-codex-task",
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_mcp",
    extensionRuntimeId: "runtime_mcp",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const queryCommands = [];
  const documentReadCommands = [];
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    if (message.method === "page.snapshot") {
      extension.send({
        kind: "command.result",
        operationId: message.operationId,
        result: {
          url: "https://example.com/",
          title: "",
          readyState: "complete",
          text: "",
          controls: [],
        },
      });
    } else if (message.method === "page.inspectDropdown") {
      extension.send({
        kind: "command.result",
        operationId: message.operationId,
        result: {
          supported: true,
          kind: "native_select",
          url: "https://example.com/",
          title: "visual canary",
          locator: message.params.locator,
          options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
        },
      });
    } else if (message.method === "page.screenshot") {
      documentReadCommands.push({ method: message.method, params: message.params });
      extension.send({
        kind: "command.result",
        operationId: message.operationId,
        result: {
          kind: "screenshot",
          mimeType: "image/jpeg",
          dataBase64: "aGVsbG8=",
          bytes: 5,
          quality: 60,
          tabId: message.params.tabId,
          windowId: 1,
          url: "https://example.com/",
          title: "visual canary",
          restored: true,
          capturedAt: new Date().toISOString(),
        },
      });
    } else if (message.method === "page.accessibilitySnapshot") {
      documentReadCommands.push({ method: message.method, params: message.params });
      extension.send({ kind: "command.result", operationId: message.operationId, result: { kind: "native_accessibility_snapshot", nodes: [], count: 0, url: "https://example.com/" } });
    } else if (message.method === "page.query") {
      queryCommands.push(message.params);
      extension.send({ kind: "command.result", operationId: message.operationId, result: { matches: [], count: 0, totalCount: 0, totalCountExact: true } });
    }
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/mcp/server.mjs")],
    cwd: resolve("."),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "companion-test", version: "0.1.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  const actionItems = listed.tools.find(tool => tool.name === "companion_authorized_transaction").inputSchema.properties.actions.items;
  assert.ok(listed.tools.find(tool => tool.name === "companion_authorized_transaction").inputSchema.properties.tabId);
  const actionVariants = actionItems.oneOf ?? actionItems.anyOf;
  const actionMethods = actionVariants.map(item => item.properties.method.const ?? item.properties.method.enum[0]);
  assert.ok(!listed.tools.some(tool => tool.name === "companion_click"));
  assert.ok(listed.tools.length >= 12);
  assert.ok(listed.tools.some((tool) => tool.name === "companion_open_session"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_reload_extension"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_refresh_extension"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_read_page"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_screenshot"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_inspect_dropdown"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_inspect_visual_target"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_inspect_visual_point"));
  for (const name of [
    "companion_query_page", "companion_export_content", "companion_webmcp_discover", "companion_clipboard_read", "companion_inspect_dialog", "companion_read_console",
  ]) assert.ok(listed.tools.some((tool) => tool.name === name), name);
  assert.ok(listed.tools.some((tool) => tool.name === "companion_group_task_tabs"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_transfer_handoff_tabs"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_cleanup_task_tabs"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_purge_missing_task_tabs"));
  assert.ok(listed.tools.find((tool) => tool.name === "companion_purge_missing_task_tabs").inputSchema.properties.profileInstanceId);
  assert.ok(listed.tools.some((tool) => tool.name === "companion_inspect_reconciliation"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_complete_reconciliation"));
  assert.ok(listed.tools.some((tool) => tool.name === "companion_screenshot"));
  assert.ok(actionMethods.includes("page.upload"));
  assert.ok(actionMethods.includes("page.selectOption"));
  assert.ok(listed.tools.find((tool) => tool.name === "companion_query_page").inputSchema.properties.frameId);
  const queryFields = listed.tools.find(tool => tool.name === "companion_query_page").inputSchema.properties;
  for (const name of ["locator", "attributes", "offset", "includeHidden"]) assert.ok(queryFields[name]);
  for (const method of [
    "tabs.back", "tabs.forward", "tabs.reload",
    "page.doubleClick", "page.hover", "page.setChecked", "page.pressKey", "page.selectText", "page.scroll",
  ]) {
    assert.ok(actionMethods.includes(method));
  }
  for (const method of [
    "visual.pointerMove", "visual.click", "visual.doubleClick", "visual.drag", "visual.scroll", "visual.pressKey", "visual.typeText",
  ]) {
    assert.ok(actionMethods.includes(method));
  }
  for (const method of ["page.download", "clipboard.write", "page.handleDialog"]) {
    assert.ok(actionMethods.includes(method));
  }
  const status = await client.callTool({
    name: "companion_status",
    arguments: {},
    _meta: { "x-codex-turn-metadata": { thread_id: "01test-codex-task" } },
  });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.result.logicalSessionCount, 0);
  assert.equal(status.structuredContent.result.productVersion, "0.3.2");
  assert.equal(status.structuredContent.result.clientTaskId, "01test-codex-task");
  assert.deepEqual(status.structuredContent.result.brokerClientConnection, {
    connected: true,
    connectionGeneration: 1,
    reconnectCount: 0,
  });
  assert.deepEqual(status.structuredContent.result.clientOwnedLogicalSessionIds, []);
  assert.deepEqual(status.structuredContent.result.clientOwnedExactTabLeaseIds, []);
  assert.deepEqual(status.structuredContent.result.clientOwnedTaskTabs, []);
  const opened = await client.callTool({
    name: "companion_open_session",
    arguments: { label: "visual-test" },
  });
  const sessionId = opened.structuredContent.result.sessionId;
  const reserved = await client.callTool({
    name: "companion_reserve_tab",
    arguments: { sessionId, tabId: 808 },
  });
  const ownedStatus = await client.callTool({ name: "companion_status", arguments: {} });
  const queryArgs = { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808,
    locator: { css: "a.doc", exact: true, nameRegex: { pattern: "^文書", flags: "u" }, within: { css: "section" }, nth: 1 },
    attributes: ["href", "title"], offset: 3, limit: 5, includeHidden: true };
  const queryResult = await client.callTool({ name: "companion_query_page", arguments: queryArgs });
  assert.equal(queryResult.isError, undefined);
  assert.deepEqual(queryCommands[0].locator, queryArgs.locator);
  assert.deepEqual(queryCommands[0].attributes, queryArgs.attributes);
  assert.equal(queryCommands[0].offset, 3);
  assert.equal(queryCommands[0].includeHidden, true);
  const invalidQuery = await client.callTool({ name: "companion_query_page", arguments: { sessionId, leaseId: queryArgs.leaseId, tabId: 808 } });
  assert.equal(invalidQuery.isError, true);
  const invalidIndex = await client.callTool({ name: "companion_query_page", arguments: { ...queryArgs, locator: { css: "a", nth: 1, last: true } } });
  assert.equal(invalidIndex.isError, true);
  assert.equal(queryCommands.length, 1, "invalid requests fail before broker dispatch");
  assert.deepEqual(ownedStatus.structuredContent.result.clientOwnedLogicalSessionIds, [sessionId]);
  assert.deepEqual(ownedStatus.structuredContent.result.clientOwnedExactTabLeaseIds, [reserved.structuredContent.result.leaseId]);
  assert.equal(ownedStatus.structuredContent.result.logicalSessions[0].peerId, undefined);
  assert.equal(ownedStatus.structuredContent.result.logicalSessions[0].taskId, "01test-codex-task");
  assert.equal(ownedStatus.structuredContent.result.logicalSessions[0].ownerTaskId, "01test-codex-task");
  assert.equal(ownedStatus.structuredContent.result.exactTabLeases[0].ownerTaskId, "01test-codex-task");
  const dropdown = await client.callTool({
    name: "companion_inspect_dropdown",
    arguments: {
      sessionId,
      leaseId: reserved.structuredContent.result.leaseId,
      tabId: 808,
      locator: { role: "combobox", question: "Are you authorized to work in Japan?" },
    },
  });
  assert.equal(dropdown.isError, undefined);
  assert.equal(dropdown.structuredContent.result.kind, "dropdown_visual_confirmation");
  assert.equal(dropdown.structuredContent.result.dropdownKind, "native_select");
  assert.equal(dropdown.structuredContent.result.visual_readback_verified, true);
  assert.equal(dropdown.structuredContent.result.visual.dataBase64, undefined);
  assert.equal(dropdown.structuredContent.result.visualProof.supported, true);
  assert.ok(dropdown.content.some((block) => block.type === "image" && block.data === "aGVsbG8="));
  const screenshot = await client.callTool({
    name: "companion_screenshot",
    arguments: { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808 },
  });
  assert.equal(screenshot.isError, undefined);
  assert.ok(screenshot.content.some((block) => block.type === "image" && block.data === "aGVsbG8="));
  assert.equal(screenshot.structuredContent.result.dataBase64, undefined);
  const fullScreenshot = await client.callTool({ name: "companion_screenshot", arguments: { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808, fullPage: true } });
  assert.equal(fullScreenshot.isError, undefined);
  assert.equal(documentReadCommands.at(-1).params.fullPage, true);
  const countBeforeInvalidScreenshot = documentReadCommands.length;
  const invalidScreenshot = await client.callTool({ name: "companion_screenshot", arguments: { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808, fullPage: true, clip: { x: 0, y: 0, width: 100, height: 100 } } });
  assert.equal(invalidScreenshot.isError, true);
  assert.equal(documentReadCommands.length, countBeforeInvalidScreenshot);
  const accessibility = await client.callTool({ name: "companion_read_accessibility", arguments: { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808, depth: 6, maxNodes: 100 } });
  assert.equal(accessibility.isError, undefined);
  assert.equal(accessibility.structuredContent.result.kind, "native_accessibility_snapshot");
  assert.equal(documentReadCommands.at(-1).method, "page.accessibilitySnapshot");
  assert.equal(documentReadCommands.at(-1).params.depth, 6);
  const axBaseline = "00000000-0000-4000-8000-000000000001";
  await client.callTool({ name: "companion_read_accessibility", arguments: { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808, framePath: [0, 1], sinceSnapshotId: axBaseline } });
  assert.deepEqual(documentReadCommands.at(-1).params.framePath, [0, 1]);
  assert.equal(documentReadCommands.at(-1).params.sinceSnapshotId, axBaseline);
  const automaticVisual = await client.callTool({
    name: "companion_read_page",
    arguments: { sessionId, leaseId: reserved.structuredContent.result.leaseId, tabId: 808 },
  });
  assert.equal(automaticVisual.isError, undefined);
  assert.equal(automaticVisual.structuredContent.result.kind, "readback_visual_confirmation");
  assert.equal(automaticVisual.structuredContent.result.reason, "semantic_snapshot_ambiguous");
  assert.ok(automaticVisual.content.some((block) => block.type === "image" && block.data === "aGVsbG8="));
  assert.equal(automaticVisual.structuredContent.result.visual.dataBase64, undefined);
  await client.callTool({ name: "companion_close_session", arguments: { sessionId } });
  const forged = await client.callTool({ name: "companion_open_session", arguments: { taskId: "forged" } });
  assert.equal(forged.isError, true);
  const lowLevelMutation = await client.callTool({
    name: "companion_click",
    arguments: { sessionId: "s", leaseId: "l", tabId: 1, locator: { role: "button", name: "Save" } },
  });
  assert.equal(lowLevelMutation.isError, true);
  await client.close();
  await transport.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});
