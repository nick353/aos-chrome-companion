import { CompanionError } from "../shared/errors.mjs";

const HOST_THREAD_KEYS = new Set([
  "openai/threadId",
  "openai/thread_id",
  "codexThreadId",
  "codex_thread_id",
  "threadId",
  "thread_id",
].map((key) => key.toLowerCase()));
const TURN_METADATA_KEY = "x-codex-turn-metadata";
const HOST_WRAPPER_KEYS = new Set([
  "codex-app-tools",
  "codex_app_tools",
  "codex/app-tools",
  "codex/app_tools",
]);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseMetadata(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectHostThreadIds(value, output = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return output;
  const parsed = parseMetadata(value);
  if (parsed !== value) return collectHostThreadIds(parsed, output, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) collectHostThreadIds(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (HOST_THREAD_KEYS.has(normalizedKey)) {
      const id = text(child);
      if (id) output.push({ id, key });
      continue;
    }
    if (normalizedKey === "thread" && child && typeof child === "object" && !Array.isArray(child)) {
      const id = text(child.id);
      if (id) output.push({ id, key: "thread.id" });
      continue;
    }
    if (normalizedKey === TURN_METADATA_KEY || normalizedKey === "_meta" || HOST_WRAPPER_KEYS.has(normalizedKey)) {
      collectHostThreadIds(child, output, depth + 1);
    }
  }
  return output;
}

function requestMetadata(extra) {
  if (!extra || typeof extra !== "object") return null;
  const metadata = { _meta: extra._meta };
  const headers = extra.requestInfo?.headers;
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "x-codex-turn-metadata") metadata[key] = value;
    }
  }
  return metadata;
}

export function resolveHostCodexTaskId(extra) {
  const candidates = collectHostThreadIds(requestMetadata(extra));
  const ids = [...new Set(candidates.map(({ id }) => id))];
  if (ids.length > 1) {
    throw new CompanionError(
      "codex_thread_identity_conflict",
      "MCP request metadata contains conflicting Codex task identities",
      { taskIds: ids },
    );
  }
  return ids[0] ?? null;
}

export function resolveCodexTaskId(env = process.env, extra = undefined) {
  const hostTaskId = resolveHostCodexTaskId(extra);
  const envTaskId = (() => {
    for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]) {
      const value = text(env?.[key]);
      if (value) return value;
    }
    return null;
  })();
  if (hostTaskId && envTaskId && hostTaskId !== envTaskId) {
    throw new CompanionError(
      "codex_thread_identity_conflict",
      "Host MCP metadata does not match the Companion process task identity",
      { hostTaskId, envTaskId },
    );
  }
  return hostTaskId ?? envTaskId;
}

export function bindCodexTaskId(candidate, env = process.env, extra = undefined) {
  const taskId = resolveCodexTaskId(env, extra);
  if (!taskId) {
    throw new CompanionError(
      "codex_thread_identity_unavailable",
      "Codex did not provide a task identity to the Companion MCP process",
    );
  }
  if (candidate !== undefined && candidate !== null && String(candidate) !== taskId) {
    throw new CompanionError(
      "task_id_mismatch",
      "Caller-supplied taskId does not match this Codex task",
      { expectedTaskId: taskId, receivedTaskId: String(candidate) },
    );
  }
  return taskId;
}

export class McpTaskBindingRegistry {
  #sessions = new Map();
  #leases = new Map();

  bindSession(sessionId, taskId) {
    const session = text(sessionId);
    const task = text(taskId);
    if (!session || !task) throw new TypeError("sessionId and taskId are required");
    this.#sessions.set(session, task);
  }

  assertSession(sessionId, taskId) {
    const session = text(sessionId);
    const task = text(taskId);
    const boundTask = this.#sessions.get(session);
    if (!boundTask) {
      throw new CompanionError("mcp_session_task_binding_missing", "MCP session is not bound to a task in this process", { sessionId: session });
    }
    if (boundTask !== task) {
      throw new CompanionError("mcp_session_task_mismatch", "MCP session belongs to another Codex task", { sessionId: session });
    }
    return session;
  }

  bindLease(leaseId, sessionId, taskId) {
    const lease = text(leaseId);
    this.assertSession(sessionId, taskId);
    if (!lease) throw new TypeError("leaseId is required");
    this.#leases.set(lease, { sessionId: text(sessionId), taskId: text(taskId) });
  }

  assertLease(leaseId, sessionId, taskId) {
    this.assertSession(sessionId, taskId);
    const lease = this.#leases.get(text(leaseId));
    if (!lease) {
      throw new CompanionError("mcp_lease_task_binding_missing", "MCP lease is not bound to a task in this process", { leaseId: text(leaseId) });
    }
    if (lease.sessionId !== text(sessionId) || lease.taskId !== text(taskId)) {
      throw new CompanionError("mcp_lease_task_mismatch", "MCP lease belongs to another Codex task or session", { leaseId: text(leaseId) });
    }
    return lease;
  }

  sessionForLease(leaseId) {
    const lease = this.#leases.get(text(leaseId));
    if (!lease) {
      throw new CompanionError("mcp_lease_task_binding_missing", "MCP lease is not bound to a task in this process", { leaseId: text(leaseId) });
    }
    return lease.sessionId;
  }

  forgetLease(leaseId) {
    this.#leases.delete(text(leaseId));
  }

  forgetSession(sessionId) {
    const session = text(sessionId);
    this.#sessions.delete(session);
    for (const [leaseId, lease] of this.#leases) {
      if (lease.sessionId === session) this.#leases.delete(leaseId);
    }
  }
}
