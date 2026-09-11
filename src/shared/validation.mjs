import { MAX_OPERATION_TIMEOUT_MS } from "./constants.mjs";
import { CompanionError } from "./errors.mjs";

export function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionError("invalid_request", `${name} must be an object`);
  }
  return value;
}

export function requireString(value, name, { max = 256 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CompanionError("invalid_request", `${name} must be a non-empty string up to ${max} characters`);
  }
  return value;
}

export function requireTabId(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CompanionError("invalid_tab_id", "tabId must be a non-negative safe integer");
  }
  return value;
}

export function normalizeTimeout(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_OPERATION_TIMEOUT_MS) {
    throw new CompanionError(
      "invalid_timeout",
      `timeoutMs must be an integer between 100 and ${MAX_OPERATION_TIMEOUT_MS}`,
    );
  }
  return value;
}

