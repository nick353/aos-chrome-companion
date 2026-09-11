#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { BrokerClient, withBrokerRequestSignal } from "../client/broker-client.mjs";
import { PRODUCT_VERSION, PROTOCOL_VERSION } from "../shared/constants.mjs";
import { transactionActionSchema } from "./action-schema.mjs";
import { toolResult, taskStatus } from "./result.mjs";
import { normalizeError, CompanionError } from "../shared/errors.mjs";
import { materializeTransactionActions } from "./action-materializer.mjs";
import { bindCodexTaskId, McpTaskBindingRegistry, resolveCodexTaskId } from "./task-context.mjs";
import { normalizeBinaryClipboardRequest } from "../shared/peripheral-policy.mjs";
import { readUrls } from "./read-urls.mjs";

let brokerClientPromise;
function broker() {
  brokerClientPromise ??= BrokerClient.connect().catch(error => {
    // A transient first connection failure must not poison every later tool.
    brokerClientPromise = undefined;
    throw error;
  });
  return brokerClientPromise;
}

function toolError(error) {
  const normalized = normalizeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(normalized, null, 2) }],
  };
}

const taskBindings = new McpTaskBindingRegistry();

function currentTaskId(extra) {
  return bindCodexTaskId(undefined, process.env, extra);
}

function assertSession(args, extra) {
  const taskId = currentTaskId(extra);
  taskBindings.assertSession(args.sessionId, taskId);
  return taskId;
}

function assertSessionAndLease(args, extra) {
  const taskId = assertSession(args, extra);
  taskBindings.assertLease(args.leaseId, args.sessionId, taskId);
  return taskId;
}

function guarded(handler, { summarizeTransactionText = false } = {}) {
  return async (args, extra) => {
    try {
      return toolResult(await withBrokerRequestSignal(extra?.signal, () => handler(args, extra)), {
        textDetail: summarizeTransactionText && args.responseDetail !== "full" ? "summary" : "full",
        detail: args.responseDetail === "compact" ? "compact" : "full",
      });
    } catch (error) {
      return toolError(error);
    }
  };
}



function snapshotNeedsVisualConfirmation(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return true;
  if (snapshot.readyState && snapshot.readyState !== "complete") return true;
  const text = typeof snapshot.text === "string" ? snapshot.text.trim() : "";
  const controls = Array.isArray(snapshot.controls) ? snapshot.controls : [];
  return text.length === 0 && controls.length === 0;
}

const sessionId = z.string().min(1).describe("Logical session returned by companion_open_session");
const leaseId = z.string().min(1).describe("Exact-tab lease returned by companion_reserve_tab");
const tabId = z.number().int().nonnegative().describe("Exact Chrome tab ID");
const locator = z.object({
  frameId: z.number().int().min(0).optional(),
  css: z.string().min(1).max(1_000).optional().describe("CSS selector within the exact document and open Shadow DOM; may be combined with semantic fields"),
  exact: z.boolean().optional().describe("Require exact normalized text for name, text, label, placeholder and title; false explicitly uses substring matching"),
  nameRegex: z.object({ pattern: z.string().min(1).max(250), flags: z.string().regex(/^[imu]*$/u).default("iu") }).optional().describe("Regular expression over the accessible name"),
  textRegex: z.object({ pattern: z.string().min(1).max(250), flags: z.string().regex(/^[imu]*$/u).default("iu") }).optional().describe("Regular expression over visible element text"),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  value: z.string().optional(),
  hasText: z.string().max(1_000).optional().describe("Keep elements containing this text"),
  hasNotText: z.string().max(1_000).optional().describe("Exclude elements containing this text"),
  has: z.record(z.string(), z.unknown()).optional().describe("Require a descendant matching this locator, including descendants through open Shadow DOM"),
  hasNot: z.record(z.string(), z.unknown()).optional().describe("Exclude elements with a descendant matching this locator"),
  state: z.record(z.string(), z.unknown()).optional().describe("Exact observable control state such as {checked:false,disabled:false,expanded:true}"),
  ancestor: z.record(z.string(), z.unknown()).optional().describe("A semantic locator that must match one ancestor, including open Shadow DOM hosts"),
  within: z.record(z.string(), z.unknown()).optional().describe("A semantic locator that must contain the target in its ancestor chain"),
  allOf: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe("Additional semantic constraints that must all match"),
  anyOf: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe("Alternative semantic constraints; at least one must match"),
  testId: z.string().min(1).optional(),
  ordinal: z.number().int().min(0).max(99).optional(),
  nth: z.number().int().min(0).max(4_999).optional().describe("Zero-based match index after filtering; omit to require one target for mutations"),
  last: z.literal(true).optional().describe("Choose the last match after filtering"),
}).refine((value) => Object.keys(value).some((key) => !["frameId", "exact", "ordinal", "nth", "last", "ancestor", "within"].includes(key)), "Provide at least one selector field")
  .refine(value => [value.ordinal, value.nth, value.last].filter(part => part !== undefined).length <= 1, "Use only one of ordinal, nth, or last");
const taskCapsule = z.record(z.string(), z.unknown()).optional()
  .describe("Internal task_execution_capsule_v1 fields; no separate runtime or manual tab configuration is required");

const server = new McpServer({
  name: "aos-chrome-companion",
  version: PRODUCT_VERSION,
}, {
  capabilities: { logging: {} },
  instructions: [
    "Prefer Companion for normal Chrome work. Use one task-owned session and exact-tab lease; foreign resources are informational, never adopt them.",
    "Use authorized transactions for mutations, inspect returned native images, and read back the result. For dropdown ambiguity refine the observed locator on the same tab.",
    "Use one semantic click for submit. Reconcile uncertain effects before continuation; never replay a dispatched submission. Browser dispatch is not provider completion. Refresh only at an idle boundary.",
  ].join(" "),
});

server.registerTool("companion_status", {
  description: "Read the local Companion broker, connected profile, session, lease, queue, and pending-operation status. Foreign task resources are informational; they do not block a distinct task-owned target and must never be adopted or cleaned up by this task.",
  inputSchema: { detail: z.enum(["task", "all"]).default("task").describe("Task-scoped inventory by default; all includes diagnostic history and foreign resources") },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  const client = await broker();
  // Keep the first stale-socket timeout below the outer MCP tool deadline so
  // BrokerClient can reconnect once and return a fresh read-only status in the
  // same tool call. Mutations retain their existing no-replay deadlines.
  const result = await client.request("status.get", {}, { timeoutMs: 5_000 });
  const clientTaskId = resolveCodexTaskId(process.env, extra);
  const ownedSessions = (result.logicalSessions || []).filter((session) => session.taskId === clientTaskId);
  const ownedSessionIds = new Set(ownedSessions.map((session) => session.sessionId));
  const ownedLeases = (result.exactTabLeases || []).filter((lease) => ownedSessionIds.has(lease.sessionId));
  const ownedTaskTabs = (result.taskTabs || []).filter((tab) => tab.taskId === clientTaskId);
  return {
    ...taskStatus(result, clientTaskId, args.detail),
    clientTaskId,
    brokerClientConnection: client.connectionInfo(),
    clientOwnedLogicalSessionIds: ownedSessions.map((session) => session.sessionId),
    clientOwnedExactTabLeaseIds: ownedLeases.map((lease) => lease.leaseId),
    clientOwnedTaskTabs: ownedTaskTabs,
  };
}));

server.registerTool("companion_capabilities", {
  description: "Read the static, machine-readable Companion capability contract and observed runtime contract. This is read-only and never creates tabs, leases, or page operations.",
  inputSchema: { methods: z.array(z.string().min(1).max(120)).max(100).optional().describe("Optional exact operation methods to return") },
  annotations: { readOnlyHint: true },
}, guarded(async (args) => {
  const result = await (await broker()).request("capabilities.get", {}, { timeoutMs: 5_000 });
  if (!args.methods?.length) return result;
  const wanted = new Set(args.methods);
  return { ...result, capabilities: (result.capabilities ?? []).filter(capability => wanted.has(capability.method)), requestedMethods: args.methods };
}));

server.registerTool("companion_reload_extension", {
  description: "Request one signed, profile-global reload of the installed Companion Extension without opening chrome://extensions. The broker defers the request while leases, pending operations, or reconciliation tabs exist; after acceptance, reacquire a fresh logical session and verify the new generation with companion_status.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    reason: z.string().min(1).max(240).optional(),
    expectedBuildId: z.string().min(1).max(128).optional(),
    authorityTtlMs: z.number().int().min(30_000).max(600_000).optional(),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestExtensionReload({ ...args, taskId });
}));

server.registerTool("companion_refresh_extension", {
  description: "At a safe idle boundary, request one signed Companion Extension reload and wait for fresh status to prove a new profile generation. Active sessions, leases, pending work, queues, reconciliation, and missing extension.reload capability defer without opening chrome://extensions or replaying any task. A reflected result requires a new logical session and reacquisition of target leases.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    profileInstanceId: z.string().min(1).optional(),
    reason: z.string().min(1).max(240).optional(),
    expectedBuildId: z.string().min(1).max(128).optional(),
    authorityTtlMs: z.number().int().min(30_000).max(600_000).optional(),
    timeoutMs: z.number().int().min(5_000).max(120_000).optional(),
    pollIntervalMs: z.number().int().min(50).max(2_000).optional(),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestExtensionReloadAndReadback({ ...args, taskId }, {
    timeoutMs: args.timeoutMs ?? 30_000,
    pollIntervalMs: args.pollIntervalMs ?? 250,
  });
}));

server.registerTool("companion_open_session", {
  description: "Open a generation-fenced logical browser session. A unique connected Companion profile is selected automatically.",
  inputSchema: {
    label: z.string().max(128).optional(),
    profileInstanceId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  const result = await (await broker()).request("session.open", { ...args, taskId });
  taskBindings.bindSession(result.sessionId, taskId);
  return result;
}));

server.registerTool("companion_close_session", {
  description: "Close a logical session, release every exact-tab lease, and by default close completed/failed plus safe pre-effect discovered task-owned tabs. Unknown-effect tabs whose owner/transport was lost use ledger-only retention: the tab is disposable and the signed operation/capsule evidence remains without replay. Returns an owner_cleanup_receipt.v1 with closed, retained, skipped, missing, and unknown-effect evidence. Explicit taskTerminal=false skips terminal cleanup. The closing session’s idle leases stay reserved through cleanup and are then released. User-help, pinned, foreign-leased, and actively executing tabs remain protected.",
  inputSchema: { sessionId, taskTerminal: z.boolean().optional() },
}, guarded(async (args, extra) => {
  assertSession(args, extra);
  const result = await (await broker()).request("session.close", args);
  if (result.closed) taskBindings.forgetSession(args.sessionId);
  return result;
}));

server.registerTool("companion_list_tabs", {
  description: "List sanitized tabs in the session's exact connected Chrome profile.",
  inputSchema: { sessionId },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId }, extra) => {
  assertSession({ sessionId: currentSessionId }, extra);
  return (await broker()).request("operation.execute", {
  sessionId: currentSessionId,
  method: "tabs.list",
  params: {},
  });
}));

server.registerTool("companion_search_browser_library", {
  description: "Search history or bookmarks in this session's connected Chrome profile after the user enables that optional access in the Companion panel. Returns bounded page metadata, omits blocked sites and protected URLs, and stores no copy in Companion. This does not open pages or change bookmarks.",
  inputSchema: { sessionId, source: z.enum(["history", "bookmarks"]), query: z.string().max(200).default(""),
    limit: z.number().int().min(1).max(100).default(50), startTime: z.number().nonnegative().optional(), endTime: z.number().nonnegative().optional() },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSession(args, extra);
  const { sessionId: currentSessionId, ...params } = args;
  return (await broker()).request("operation.execute", { sessionId: currentSessionId, method: "browser.searchLibrary", params });
}));

server.registerTool("companion_list_windows", {
  description: "List normal windows in the connected Chrome profile. Use a returned ID as destinationWindowId in tabs.configure to move this task's own tab. No window is opened, closed or focused by this read.",
  inputSchema: { sessionId }, annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSession(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, method: "browser.listWindows", params: {} });
}));

server.registerTool("companion_reserve_tab", {
  description: "Acquire the calling session's exclusive exact-tab lease. A tab leased by another session is rejected.",
  inputSchema: { sessionId, tabId },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  const result = await (await broker()).request("lease.acquire", args);
  taskBindings.bindLease(result.leaseId, args.sessionId, taskId);
  return result;
}));

server.registerTool("companion_release_tab", {
  description: "Release an exact-tab lease owned by this MCP client session.",
  inputSchema: { leaseId },
}, guarded(async (args, extra) => {
  const taskId = currentTaskId(extra);
  const lease = taskBindings.assertLease(args.leaseId, taskBindings.sessionForLease(args.leaseId), taskId);
  const result = await (await broker()).request("lease.release", args);
  if (result.released) taskBindings.forgetLease(lease.leaseId);
  return result;
}));


server.registerTool("companion_read_page", {
  description: "Read a bounded semantic snapshot and always capture a visual screenshot from the same exact leased tab. Treat any semantic/visual disagreement as unresolved instead of trusting semantic readback alone.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    maxTextChars: z.number().int().min(1_000).max(100_000).default(30_000),
  },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId, leaseId: currentLeaseId, tabId: currentTabId, maxTextChars }, extra) => {
  assertSessionAndLease({ sessionId: currentSessionId, leaseId: currentLeaseId }, extra);
  const client = await broker();
  let semantic = null;
  let semanticError = null;
  try {
    semantic = await client.request("operation.execute", {
      sessionId: currentSessionId,
      leaseId: currentLeaseId,
      method: "page.snapshot",
      params: { tabId: currentTabId, maxTextChars },
    });
  } catch (error) {
    semanticError = normalizeError(error);
  }
  const visual = await client.request("operation.execute", {
    sessionId: currentSessionId,
    leaseId: currentLeaseId,
    method: "page.screenshot",
    params: { tabId: currentTabId },
    timeoutMs: 30_000,
  });
  return {
    kind: "readback_visual_confirmation",
    reason: semanticError
      ? "semantic_snapshot_error"
      : snapshotNeedsVisualConfirmation(semantic)
        ? "semantic_snapshot_ambiguous"
        : "proactive_visual_confirmation",
    semantic,
    semanticError,
    visual,
  };
}));

server.registerTool("companion_read_accessibility", {
  description: "Read Chrome's native accessibility tree for the exact leased tab, with computed roles, names and states, excluding form values and editable descendants. framePath selects a permitted nested child by zero-based indices. Returned one-based indices belong only to that snapshot and cannot be used as action targets. Pass sinceSnapshotId for a compact diff of the same task/session/document and the same options; baselines expire in five minutes. Requires the existing Companion debugger opt-in.",
  inputSchema: { sessionId, leaseId, tabId, maxNodes: z.number().int().min(1).max(2_000).default(500), depth: z.number().int().min(1).max(50).default(12), includeIgnored: z.boolean().default(false),
    framePath: z.array(z.number().int().min(0).max(99)).max(8).optional(), sinceSnapshotId: z.string().uuid().optional() },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.accessibilitySnapshot", params: args });
}));

server.registerTool("companion_list_page_assets", {
  description: "Inventory images, videos, fonts, stylesheets, scripts and inline SVGs already observed in the exact leased document. Includes source attributes, computed styles, accessible CSS rules and resource timing without fetching URLs. Open shadow roots are included; select a frameId explicitly for a permitted child frame. Load lazy content first and repeat the read. Returns bounded untrusted page data with truncation and inaccessible stylesheet details; this lists assets and does not bundle files.",
  inputSchema: { sessionId, leaseId, tabId, frameId: z.number().int().nonnegative().optional(),
    kinds: z.array(z.enum(["image", "video", "font", "stylesheet", "script", "other"])).min(1).max(6).optional(),
    limit: z.number().int().min(1).max(500).default(100), maxElements: z.number().int().min(1).max(5000).default(1000),
    maxBytes: z.number().int().min(10000).max(500000).default(150000), includeInlineSvgs: z.boolean().default(true), includeComputedStyles: z.boolean().default(true) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.assets", params: args });
}));

server.registerTool("companion_screenshot", {
  description: "Capture the exact leased tab. Default viewport capture temporarily activates the tab and restores it. fullPage or clip (document CSS pixels) uses the existing debugger opt-in without changing viewport or active tab; choose only one. Outputs a native image with capture bounds.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    quality: z.number().int().min(35).max(90).default(60),
    maxBytes: z.number().int().min(100_000).max(2_000_000).default(700_000),
    restoreActive: z.boolean().default(true),
    fullPage: z.boolean().default(false),
    clip: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive().max(32_768), height: z.number().positive().max(32_768) }).optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId, leaseId: currentLeaseId, tabId: currentTabId, quality, maxBytes, restoreActive, fullPage, clip }, extra) => {
  assertSessionAndLease({ sessionId: currentSessionId, leaseId: currentLeaseId }, extra);
  if (fullPage && clip) throw new CompanionError("screenshot_options_invalid", "Choose fullPage or clip, not both");
  return (await broker()).request("operation.execute", {
    sessionId: currentSessionId,
    leaseId: currentLeaseId,
    method: "page.screenshot",
    params: { tabId: currentTabId, quality, maxBytes, restoreActive, fullPage, clip },
    timeoutMs: 30_000,
  });
}));

server.registerTool("companion_inspect_dropdown", {
  description: "Read-only semantic plus screenshot preflight for one question/label-scoped dropdown before any form mutation. Inspect the returned image. If supported=true, pass visualProof unchanged to page.selectOption. If supported=null or semantic_locator_ambiguous, inspect candidates, refine role/name/label and repeat this read-only preflight on the same Companion tab. Only supported=false with companion_dropdown_control_unsupported is a handoff candidate; do not coordinate-click the control.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    locator,
  },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId, leaseId: currentLeaseId, tabId: currentTabId, locator: currentLocator }, extra) => {
  assertSessionAndLease({ sessionId: currentSessionId, leaseId: currentLeaseId }, extra);
  return (await broker()).request("dropdown.inspect", {
    sessionId: currentSessionId,
    leaseId: currentLeaseId,
    tabId: currentTabId,
    locator: currentLocator,
  }, {
    timeoutMs: 30_000,
  });
}));

server.registerTool("companion_inspect_visual_target", {
  description: "Read-only semantic geometry plus exact screenshot proof for one visible target. Inspect the returned image, then pass visualProof unchanged to one visual.* action in an authorized transaction. The proof is exact-tab-bound, expires after 60 seconds, and is single-use.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    locator,
  },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId, leaseId: currentLeaseId, tabId: currentTabId, locator: currentLocator }, extra) => {
  assertSessionAndLease({ sessionId: currentSessionId, leaseId: currentLeaseId }, extra);
  return (await broker()).request("visual.target.inspect", {
    sessionId: currentSessionId,
    leaseId: currentLeaseId,
    tabId: currentTabId,
    locator: currentLocator,
  }, { timeoutMs: 30_000 });
}));

server.registerTool("companion_inspect_visual_point", {
  description: "Read-only screenshot-bound confirmation for a user-visible point in the exact leased tab. Inspect the returned image, then pass visualProof unchanged to one visual.* action. This never moves the OS cursor; the Companion only renders a temporary blue in-page cursor and uses exact-tab CDP input if explicitly enabled.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    point: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }),
  },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId, leaseId: currentLeaseId, tabId: currentTabId, point: currentPoint }, extra) => {
  assertSessionAndLease({ sessionId: currentSessionId, leaseId: currentLeaseId }, extra);
  return (await broker()).request("visual.point.inspect", {
    sessionId: currentSessionId,
    leaseId: currentLeaseId,
    tabId: currentTabId,
    point: currentPoint,
  }, { timeoutMs: 30_000 });
}));

server.registerTool("companion_query_page", {
  description: "Read exact-tab elements by text or a semantic/CSS locator. Returns match counts, paginated results, and explicitly requested attributes; no arbitrary JavaScript execution. Hidden elements require includeHidden=true.",
  inputSchema: { sessionId, leaseId, tabId, frameId: z.number().int().min(0).optional(), query: z.string().min(1).max(500).optional(), locator: locator.optional(),
    attributes: z.array(z.string().regex(/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u).max(100)).max(16).optional(),
    includeHidden: z.boolean().optional(), offset: z.number().int().min(0).max(4_999).default(0), limit: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  if (!args.query && !args.locator) throw new CompanionError("page_query_invalid", "Provide a query or locator");
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.query", params: {
    tabId: args.tabId, frameId: args.frameId, query: args.query, locator: args.locator, attributes: args.attributes,
    includeHidden: args.includeHidden, offset: args.offset, limit: args.limit,
  } });
}));

server.registerTool("companion_export_content", {
  description: "Export bounded page text or sanitized inert HTML. Form values and active code are removed.",
  inputSchema: { sessionId, leaseId, tabId, format: z.enum(["text", "html"]).default("text"), maxChars: z.number().int().min(1_000).max(100_000).default(50_000) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.exportContent", params: { tabId: args.tabId, format: args.format, maxChars: args.maxChars } });
}));

server.registerTool("companion_webmcp_discover", {
  description: "Discover only the fixed navigator.modelContext capability shape. This never invokes a page tool.",
  inputSchema: { sessionId, leaseId, tabId },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.webMcpDiscover", params: { tabId: args.tabId } });
}));

server.registerTool("companion_webmcp_call", {
  description: "Invoke one explicitly allowlisted page-declared WebMCP tool. This is never an arbitrary JavaScript/eval path and requires per-call approval plus an origin allowlist.",
  inputSchema: {
    sessionId, leaseId, tabId,
    toolName: z.string().min(1).max(120),
    arguments: z.record(z.string(), z.unknown()).default({}),
    allowedToolNames: z.array(z.string().min(1).max(120)).min(1).max(32),
    approved: z.literal(true),
    allowedOrigins: z.array(z.string().url()).min(1).max(16),
    maxResultBytes: z.number().int().min(1).max(262144).default(262144),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  if (!args.allowedToolNames.includes(args.toolName)) throw new Error("webmcp_tool_not_allowlisted");
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.webMcpCall", params: { ...args, tabId: args.tabId } });
}));

server.registerTool("companion_export_artifact", {
  description: "Export bounded sanitized page content as a named inert artifact descriptor.",
  inputSchema: { sessionId, leaseId, tabId, format: z.enum(["text", "html"]).default("text"), artifactName: z.string().min(1).max(120).default("page-export"), maxChars: z.number().int().min(1000).max(100000).default(50000) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.exportArtifact", params: args });
}));

server.registerTool("companion_inspect_captcha", {
  description: "Classify only a visibly rendered CAPTCHA widget. Passive text or hidden site-key markup is not a blocker; a visible widget is returned as user_action_required without attempting to solve it.",
  inputSchema: { sessionId, leaseId, tabId },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.inspectCaptcha", params: args });
}));

server.registerTool("companion_dom_diff", {
  description: "Compare a bounded semantic snapshot against the current page and return added/removed/changed visible controls.",
  inputSchema: { sessionId, leaseId, tabId, previous: z.record(z.string(), z.unknown()).optional(), maxItems: z.number().int().min(1).max(100).default(100) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.domDiff", params: args });
}));

server.registerTool("companion_observe_page", {
  description: "Register console/network or selected page events before an action, then read entries using the exact observationId and cursor. Page events include navigation/load state, popup requests and exact opener associations, file chooser, dialog, and best-effort legacy download events. Popup association does not grant tab ownership; chooser observation does not select files. The task-owned tab, session and generation stay bound. Returns request/response/status/frame and bounded console text; headers and request bodies are omitted. Text response bodies require allowResponseBodies at start plus a finished same-origin requestId. No requests are replayed. Stop releases this observer's debugger share; session close/disconnect/tab close also stop it. Capture is in memory, lasts up to durationMs, and reports dropped entries/cursor gaps. Existing visual input and document reads share the debugger attachment.",
  inputSchema: { sessionId, leaseId, tabId, action: z.enum(["start", "read", "body", "stop"]), observationId: z.string().max(200).optional(), cursor: z.string().max(250).optional(),
    console: z.boolean().default(true), network: z.boolean().default(true), allowResponseBodies: z.boolean().default(false),
    events: z.array(z.enum(["navigation", "popup", "fileChooser", "dialog", "download"])).max(5).default([]),
    durationMs: z.number().int().min(1000).max(1800000).default(300000), maxEntries: z.number().int().min(10).max(5000).default(1000),
    maxBufferBytes: z.number().int().min(10000).max(2000000).default(1000000), limit: z.number().int().min(1).max(500).default(100),
    maxBytes: z.number().int().min(10000).max(500000).default(100000), requestId: z.string().max(160).optional(), maxChars: z.number().int().min(100).max(100000).default(20000) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.observe", params: args });
}));

server.registerTool("companion_read_network", {
  description: "Read bounded current-page Resource Timing entries. This is not historical packet capture and does not read request bodies or credentials.",
  inputSchema: { sessionId, leaseId, tabId, maxEntries: z.number().int().min(1).max(200).default(100), includeInitiator: z.boolean().default(false) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.readNetwork", params: args });
}));

server.registerTool("companion_element_screenshot", {
  description: "Capture a cropped image of one main-frame element without scrolling or changing the viewport. Geometry and document are verified before and after capture. Set mode=viewport for the legacy full viewport image plus target bounds.",
  inputSchema: { sessionId, leaseId, tabId, locator, mode: z.enum(["crop", "viewport"]).default("crop"), quality: z.number().int().min(35).max(90).default(60), maxBytes: z.number().int().min(100000).max(2_000_000).default(700000) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.elementScreenshot", params: args });
}));

server.registerTool("companion_clipboard_read", {
  description: "Read up to 100000 clipboard characters through the optional clipboard permission with token-like values redacted. The operation is profile-global and serialized.",
  inputSchema: { sessionId, leaseId, tabId },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "clipboard.read", params: { tabId: args.tabId } });
}));

server.registerTool("companion_clipboard_read_binary", {
  description: "Read explicitly approved clipboard binary items with MIME and size allowlists. Clipboard history and unapproved reads are denied; content is not logged by Companion.",
  inputSchema: { sessionId, leaseId, tabId, mimeTypes: z.array(z.string()).min(1).max(8), maxBytes: z.number().int().min(1).max(2097152).default(2097152), approved: z.literal(true) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  const policy = normalizeBinaryClipboardRequest(args);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "clipboard.readBinary", params: { ...args, ...policy } });
}));

server.registerTool("companion_claim_existing_tab", {
  description: "Request a one-time explicit approval to claim an existing tab. No tab is adopted without a signed approval bound to the complete target fingerprint; active, pinned, foreign, official-Extension, and authentication tabs remain unclaimable.",
  inputSchema: { sessionId, tabId, approval: z.record(z.string(), z.unknown()), targetIdentity: z.record(z.string(), z.unknown()), targetFingerprint: z.string().min(32).max(512), origin: z.string().url().optional() },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  assertSession(args, extra);
  if (args.approval?.approved !== true) throw new Error("existing_tab_claim_requires_signed_approval");
  return (await broker()).request("tabs.claimExisting", args);
}));

server.registerTool("companion_inspect_dialog", {
  description: "Start or read a five-minute, task-owned dialog observation on the exact leased tab before triggering a dialog. Chromium does not replay dialogs that predate observation. Returns the opening identity for a single-action signed page.handleDialog transaction on that tab; ordinary prompts accept explicit promptText. Use action:stop after the dialog is closed. This never accepts or dismisses a dialog.",
  inputSchema: { sessionId, leaseId, tabId, action: z.enum(["inspect", "stop"]).default("inspect") },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.inspectDialog", params: { tabId: args.tabId, action: args.action } });
}));

server.registerTool("companion_read_console", {
  description: "Capture a bounded 750ms window of redacted console/log events from the exact leased tab. Historical replay is not claimed.",
  inputSchema: { sessionId, leaseId, tabId },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSessionAndLease(args, extra);
  return (await broker()).request("operation.execute", { sessionId: args.sessionId, leaseId: args.leaseId, method: "page.readConsole", params: { tabId: args.tabId } });
}));





server.registerTool("companion_authorized_transaction", {
  description: "Run an authorized semantic action sequence in this Codex task's grouped, reusable Companion tab. Use intent=direct_application only for a normal current-owner job application; it is not a source-return or handoff bypass. Use page.selectOption with a question/label-scoped locator and option {label|value|index} for native selects and ARIA/custom listboxes; pass an option array only for a native select with multiple=true to replace its complete selection set. Use page.selectText with one exact contenteditable locator and exact text before rich-editor toolbar clicks. For a visible submit control use one exact page.click only; if it returns operation_effect_unknown, reconcile and never switch to page.submit or a second click. Other and official-Extension tabs remain read-only.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    intent: z.enum(["authorized_transaction", "direct_application"]).default("authorized_transaction"),
    responseDetail: z.enum(["summary", "full", "compact"]).default("summary").describe("Concise text with complete structuredContent by default; full restores the complete JSON text. compact also removes duplicate structured evidence. Read/action results, partial progress, unknown effects and cleanup remain in every mode."),
    targetOrigin: z.string().url().optional(),
    startUrl: z.string().url(),
    tabId: z.number().int().nonnegative().optional().describe("Continue this exact task-owned tab at its current URL without reloading startUrl. Use the tab.id from the previous result. A missing, foreign, busy or protected tab fails without opening a replacement."),
    allowedOrigins: z.array(z.string().url()).min(1).max(16),
    actions: z.array(transactionActionSchema(locator)).min(1).max(32).describe("At least one action; initial read-only open uses page.query with params.query"),
    retainOnUnknown: z.boolean().default(false),
    reuseTaskTab: z.boolean().default(true),
    keepTaskTab: z.boolean().optional(),
    precondition: z.object({
      semanticQuery: z.string().min(1).max(500),
      targetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      sourceStateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    }).optional(),
    capsule: taskCapsule,
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSession(args, extra);
  const actions = await materializeTransactionActions(args.actions);
  const targetOrigin = args.targetOrigin ?? new URL(args.startUrl).origin;
  return (await broker()).requestAuthorizedTransaction({ ...args, taskId, targetOrigin, actions, precondition: args.precondition ?? null, capsule: args.capsule ?? null }, { timeoutMs: 120_000 });
}, { summarizeTransactionText: true }));

server.registerTool("companion_read_urls", {
  description: "Read 1 to 10 HTTP/HTTPS URLs in temporary task-owned tabs with at most two concurrent reads. Returns each page, partial failures, screenshots and cleanup evidence. Exact duplicate URLs are fetched once. Cancellation stops new reads and lets dispatched reads finish owner-scoped cleanup. No forms or page controls are activated.",
  inputSchema: { sessionId, runId: z.string().min(1), idempotencyKey: z.string().min(1),
    urls: z.array(z.string().url()).min(1).max(10), allowedOrigins: z.array(z.string().url()).max(16).default([]),
    concurrency: z.number().int().min(1).max(2).default(2), maxCharsPerPage: z.number().int().min(100).max(20000).default(12000) },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return readUrls(await broker(), { ...args, taskId }, { signal: extra?.signal });
}));

server.registerTool("companion_operation_history", {
  description: "Read bounded operation history for this task and its exact profile from the existing ledger. Filter by run, method or state and continue with the unchanged cursor. Returns operation state, dispatch and reconciliation metadata; page input, clipboard bytes and provider response bodies are excluded. Historical browser dispatch is not provider completion.",
  inputSchema: { sessionId, runId: z.string().min(1).max(256).optional(), method: z.string().min(1).max(128).optional(),
    state: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(4096).optional() },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  assertSession(args, extra);
  return (await broker()).request("task.history", args);
}));

server.registerTool("companion_transaction_status", {
  description: "Read durable task status with a fresh signed read-only authority. Optional audit returns a bounded page of this task/run's recorded operation metadata, with method/state/tab filters and a next cursor; raw result bodies and authority values are excluded. This never replays or dispatches the transaction. When continuation_allowed=false, resume only from the returned restart point after the exact blocker changes.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    intent: z.enum(["prepare_resume", "direct_application"]).optional(),
    idempotencyKey: z.string().min(1).optional(),
    capsuleId: z.string().min(1).optional(),
    audit: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(2048).optional(),
      method: z.string().regex(/^[A-Za-z][A-Za-z0-9.]{0,99}$/u).optional(),
      state: z.enum(["prepared", "dispatched", "applied", "unknown_effect", "reconciled", "blocked"]).optional(),
      tabId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    }).strict().optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSession(args, extra);
  return (await broker()).requestTaskStatus({ ...args, taskId });
}));

server.registerTool("companion_prepare_resume", {
  description: "Read this task's resume state and completed/remaining action indices. After a connection or generation failure, reacquire this client's own session on its original profile once and return the new session_id. Never replay actions or reuse old leases. Reserve and read back the exact returned target before continuing only the remaining work. Use intent=direct_application only for normal current-owner job applications.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    intent: z.enum(["prepare_resume", "direct_application"]).optional(),
    idempotencyKey: z.string().min(1).optional(),
    capsuleId: z.string().min(1).optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSession(args, extra);
  const client = await broker();
  try {
    return await client.requestPrepareResume({ ...args, taskId }, { timeoutMs: 5_000 });
  } catch (error) {
    if (!["broker_reconnect_required", "broker_connection_closed", "broker_request_timeout", "session_not_owned", "session_generation_stale"].includes(error?.code)) throw error;
    const session = await client.recoverOwnedSession({ sessionId: args.sessionId, taskId });
    // Drop obsolete leases even when the broker reused the logical session ID.
    taskBindings.forgetSession(args.sessionId);
    taskBindings.bindSession(session.sessionId, taskId);
    const recovery = { reason: error.code, previous_session_id: args.sessionId, session_id: session.sessionId,
      profile_instance_id: session.profileInstanceId, generation: session.generation, fresh_lease_required: true, actions_replayed: 0 };
    try {
      const result = await client.requestPrepareResume({ ...args, taskId, sessionId: session.sessionId }, { timeoutMs: 5_000 });
      return { ...result, session_recovery: recovery };
    } catch (readError) {
      readError.details = { ...readError.details, session_recovery: recovery };
      throw readError;
    }
  }
}));

server.registerTool("companion_inspect_reconciliation", {
  description: "Read the exact reconciliation tab, locate visible provider-success text, and capture a same-page screenshot. Inspect the image, then pass reconciliationProof unchanged to companion_complete_reconciliation. This performs no mutation or replay.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    capsuleId: z.string().min(1).optional(),
    successQuery: z.string().min(8).max(500),
  },
  annotations: { readOnlyHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSessionAndLease(args, extra);
  return (await broker()).requestInspectReconciliation({ ...args, taskId });
}));

server.registerTool("companion_repair_pre_dispatch_reconciliation", {
  description: "Owner-signed repair for the narrowly identified false-positive pre-dispatch visual inspection timeout. It requires fresh exact-tab inventory, proves the run contains no page/visual mutation operation, marks only that capsule failed/cleanup-ready, and never replays or claims a provider effect.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    capsuleId: z.string().min(1),
    profileInstanceId: z.string().min(1),
    tabId,
    confirmNoEffect: z.literal(true).describe("Explicitly confirm that no page or visual mutation was dispatched for this false-positive record"),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestRepairPreDispatchReadonly({ ...args, taskId });
}));

server.registerTool("companion_rebind_reconciliation", {
  description: "Rebind one exact task-owned stale-generation reconciliation tab to the current connected Companion generation after fresh status and tabs.list checks. This changes only signed task metadata, never replays the unknown operation, and returns a current-generation lease for companion_inspect_reconciliation.",
  inputSchema: {
    sessionId,
    tabId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    capsuleId: z.string().min(1),
    fromGeneration: z.string().min(1),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSession(args, extra);
  return (await broker()).requestRebindReconciliation({ ...args, taskId });
}));

server.registerTool("companion_complete_reconciliation", {
  description: "After visually confirming companion_inspect_reconciliation, atomically mark that exact reconciliation capsule and task tab completed/cleanup-ready. It revalidates the same visible success evidence, performs no provider mutation, and must be followed by companion_close_session(taskTerminal=true).",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    capsuleId: z.string().min(1),
    reconciliationProof: z.record(z.string(), z.unknown()),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSessionAndLease(args, extra);
  return (await broker()).requestCompleteReconciliation({ ...args, taskId });
}));

server.registerTool("companion_group_task_tabs", {
  description: "Group every live Companion-owned tab belonging to this exact Codex task. Set collapsed=true to fold the task group for visual cleanup. Other tasks and official-Extension tabs are never adopted.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    collapsed: z.boolean().optional(),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = bindCodexTaskId(args.taskId, process.env, extra);
  assertSession(args, extra);
  return (await broker()).requestGroupTaskTabs({ ...args, taskId });
}));

server.registerTool("companion_transfer_handoff_tabs", {
  description: "Transfer only retained Companion-owned tabs from one hookless handoff source task to this exact destination task after validating the private handoff receipt. It never adopts ordinary or official-Extension tabs and performs no page mutation.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    sourceTaskId: z.string().min(1).max(200),
    receiptPath: z.string().min(1),
    idempotencyKey: z.string().min(1),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const destinationTaskId = currentTaskId(extra);
  assertSession(args, extra);
  return (await broker()).requestTransferHandoffTabs({ ...args, destinationTaskId });
}));

server.registerTool("companion_cleanup_task_tabs", {
  description: "Close only this Codex task's Companion-tracked terminal, stale-generation, or owner-lost ledger-only tabs and fold retained reconciliation tabs for visual cleanup. Foreign task tabs must not appear anywhere in the cleanup receipt. Explicitly preserved, active, pinned, leased, live-session, resume, user-help, and non-Companion tabs are never closed. Ledger-only close uncertainty does not reattach the task to the browser tab; the close evidence remains in the operation ledger.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    preserveTabIds: z.array(tabId).max(500),
    dryRun: z.boolean().default(true),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestCleanupTaskTabs({ ...args, taskId });
}));

server.registerTool("companion_purge_missing_task_tabs", {
  description: "With explicit user approval, remove only exact Companion task-tab records whose tabs are already absent from a fresh live inventory. It never closes a live tab, adopts a foreign tab, or removes user-help/active/leased/identity-inconsistent records.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    // Keep the profile binding in the public schema so the client signs the
    // same payload that the broker verifies. Omitting it made the client send
    // profileInstanceId=null and caused authority_payload_tampered before the
    // missing-record-only safety check could run.
    profileInstanceId: z.string().min(1).optional(),
    tabIds: z.array(tabId).min(1).max(500),
    confirmMissingOnly: z.literal(true).describe("Explicitly confirm that only tabs absent from the fresh live inventory may be purged"),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestPurgeMissingTaskTabs({ ...args, taskId });
}));

server.registerTool("companion_retire_local_canary", {
  description: "Retire one abandoned localhost synthetic canary after a fresh inventory. Requires explicit synthetic-only approval; user tabs, foreign tasks, authentication pages, and provider pages are rejected. The unknown operation evidence is retained and never replayed.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    profileInstanceId: z.string().min(1).optional(),
    tabId,
    confirmSyntheticCanary: z.literal(true).describe("Explicitly confirm that this exact tab is an abandoned localhost synthetic canary"),
  },
  annotations: { destructiveHint: true },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestRetireLocalCanary({ ...args, taskId });
}));

server.registerTool("companion_archive_reconciliation", {
  description: "Owner-scoped display archive for unresolved reconciliation records. It preserves the original state, broker evidence, binding, and ledger entry; it never reconciles, replays, deletes, closes tabs, or lowers the scheduler's reconciliation gate.",
  inputSchema: {
    sessionId,
    runId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(512),
    operationIds: z.array(z.string().min(1).max(512)).min(1).max(500),
    reason: z.string().min(1).max(240).optional(),
    confirmArchiveOnly: z.literal(true).describe("Explicitly confirm display-only archival with no reconciliation, replay, deletion, or state change"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, guarded(async (args, extra) => {
  const taskId = assertSession(args, extra);
  return (await broker()).requestArchiveReconciliation({ ...args, taskId });
}));

server.registerTool("companion_wait_for", {
  description: "Wait up to 15 seconds for one uniquely matched semantic locator condition in an exact leased tab.",
  inputSchema: {
    sessionId,
    leaseId,
    tabId,
    locator,
    condition: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
    timeoutMs: z.number().int().min(100).max(15_000).default(5_000),
  },
  annotations: { readOnlyHint: true },
}, guarded(async ({ sessionId: currentSessionId, leaseId: currentLeaseId, tabId: currentTabId, locator: currentLocator, condition, timeoutMs }, extra) => {
  assertSessionAndLease({ sessionId: currentSessionId, leaseId: currentLeaseId }, extra);
  return (await broker()).request("operation.execute", {
  sessionId: currentSessionId,
  leaseId: currentLeaseId,
  method: "page.waitFor",
  params: { tabId: currentTabId, locator: currentLocator, condition, timeoutMs },
  timeoutMs: timeoutMs + 2_000,
  });
}));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`AOS Chrome Companion MCP ${PROTOCOL_VERSION} ready\n`);

async function shutdown() {
  const client = await brokerClientPromise?.catch(() => null);
  client?.close();
  await server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
