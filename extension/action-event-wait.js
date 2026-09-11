import { ACTION_EVENT_CONTRACT as contract } from "./operation-schema.generated.js";

const invalid = message => Object.assign(new Error(message), { code: "action_event_invalid",
  details: { operationEffectState: "none", mutationDispatchAttempted: false } });

export function expectedActionEvent(method, value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !contract.methods.includes(method) || !contract.types.includes(value.type)
    || Object.keys(value).some(key => !["type", "timeoutMs"].includes(key))) throw invalid("Unsupported pre-armed event request");
  const timeoutMs = value.timeoutMs ?? contract.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < contract.minTimeoutMs || timeoutMs > contract.maxTimeoutMs) throw invalid("Event timeout is outside the advertised bounds");
  return { type: value.type, timeoutMs };
}

// Keep the original command alive after reporting a modal. The broker releases
// its caller with a pending-event receipt and accepts this command's authentic
// late result after a separately signed response closes the dialog.
export async function executeWithExpectedDialog({ method, params, dialogs, prepare, execute, emit }) {
  const expectation = expectedActionEvent(method, params.expectEvent);
  if (!expectation) return execute();
  await prepare();
  const wait = await dialogs.expectOpening(params.tabId, params, expectation.timeoutMs);
  let observed = null;
  const event = wait.promise.then(value => {
    if (value) { observed = value; emit(value); }
    return value;
  });
  try {
    // Registration above precedes even a synchronous click handler.
    const result = await execute();
    await event;
    return { ...result, eventWait: { type: expectation.type, timeoutMs: expectation.timeoutMs,
      observed: observed !== null, ...(observed ? { event: observed } : { exact_blocker: "action_event_timeout" }) } };
  } finally { wait.cancel(); }
}
