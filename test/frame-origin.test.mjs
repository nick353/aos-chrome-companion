import assert from "node:assert/strict";
import test from "node:test";
import { checkFrameOrigin, resolveFrameOrigin } from "../extension/frame-origin.js";

test("top-level frame can use the exact live tab URL when Chrome omits its result URL", () => {
  const resolved = resolveFrameOrigin({ frameId: 0, result: {}, tabUrl: "https://example.test/form" });
  assert.deepEqual(resolved, { origin: "https://example.test", source: "live_tab_url", needsTabUrl: false });
  const checked = checkFrameOrigin({ frameId: 0, result: {}, tabUrl: "https://example.test/form", allowedOrigins: ["https://example.test"] });
  assert.equal(checked.allowed, true);
});

test("nested frames never inherit the top-level origin", () => {
  const resolved = resolveFrameOrigin({ frameId: 4, result: {}, tabUrl: "https://example.test/form" });
  assert.deepEqual(resolved, { origin: null, source: null, needsTabUrl: false });
  const checked = checkFrameOrigin({ frameId: 4, result: {}, tabUrl: "https://example.test/form", allowedOrigins: ["https://example.test"] });
  assert.equal(checked.allowed, false);
});

test("foreign frame origins remain rejected", () => {
  const checked = checkFrameOrigin({
    frameId: 2,
    result: { url: "https://foreign.test/embed" },
    allowedOrigins: ["https://example.test"],
  });
  assert.equal(checked.allowed, false);
  assert.equal(checked.origin, "https://foreign.test");
});

