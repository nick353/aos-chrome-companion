import { CompanionError } from "../shared/errors.mjs";

// Validate filters before candidate scanning: an empty page must not hide an
// invalid nested position selector or silently strip a malformed constraint.
export function validateLocatorTree(locator, nested = false, depth = 0) {
  const fail = message => { throw new CompanionError("semantic_locator_index_invalid", message,
    { operationEffectState: "none", mutationDispatchAttempted: false }); };
  if (!locator || typeof locator !== "object" || Array.isArray(locator) || depth > 8) fail("Provide one locator object with at most 8 nested filter levels");
  const positions = ["nth", "ordinal", "last"].filter(key => locator[key] !== undefined);
  if (positions.length > 1 || nested && positions.length) fail("Use only one of nth, ordinal, or last on the outer locator after filtering");
  for (const [key, max] of [["nth", 4999], ["ordinal", 99]]) {
    if (locator[key] !== undefined && (!Number.isSafeInteger(locator[key]) || locator[key] < 0 || locator[key] > max)) fail(`${key} must be an integer from 0 to ${max}`);
  }
  if (locator.last !== undefined && locator.last !== true) fail("last must be true or omitted");
  for (const key of ["has", "hasNot", "ancestor", "within"]) if (locator[key] !== undefined) validateLocatorTree(locator[key], true, depth + 1);
  for (const key of ["allOf", "anyOf"]) if (locator[key] !== undefined) {
    if (!Array.isArray(locator[key]) || !locator[key].length || locator[key].length > 8) fail(`${key} requires 1 to 8 locator filters`);
    for (const part of locator[key]) validateLocatorTree(part, true, depth + 1);
  }
  return locator;
}
