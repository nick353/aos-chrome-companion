#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isolatedBrowser } from "./lib/isolated-browser-fixture.mjs";

const output = resolve(process.argv[2] ?? `../../verification/r37-native-multiselect/${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(output, { recursive: true });
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const injected = source.slice(source.indexOf("async function injectedPageOperation("), source.indexOf("\nchrome.runtime.onMessage.addListener"));
const binary = process.env.COMPANION_TEST_BROWSER_BINARY ?? process.env.COMPANION_CFT_BINARY;
if (!binary) throw new Error("Set COMPANION_TEST_BROWSER_BINARY to the explicit isolated CfT binary before running this canary");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><meta charset=utf-8><style>body{font:18px system-ui;padding:24px}select{min-width:240px}#custom{display:block;margin-top:24px;padding:8px;border:1px solid #888}</style><main id=fixture></main>");
});
const receipt = {
  schema: "companion.native_multiselect_dom_canary.v1",
  startedAt: new Date().toISOString(),
  scope: "Production injected selectOption in an isolated disposable Chrome fixture; native multiple selection only.",
  browserBinary: binary,
  cases: [],
  cleanup: {},
};
let browser;

async function setup(mode) {
  await browser.evaluate(`(() => {
    const mode = ${JSON.stringify(mode)};
    const root = document.querySelector("#fixture");
    window.__r37VisualizeObserver?.disconnect();
    window.__r37VisualizeObserver = null;
    root.replaceChildren();
    window.__r37Counts = { input: 0, change: 0 };
    const select = document.createElement("select");
    select.dataset.testid = "target";
    select.id = "target";
    select.size = 4;
    select.multiple = !["single", "custom", "disabled-select"].includes(mode);
    const definitions = mode === "duplicate"
      ? [["dup", "First"], ["dup", "Second"], ["tail", "Tail"], ["dup", "Third"]]
      : mode === "ambiguous"
        ? [["same", "Same"], ["same-2", "Same"], ["other", "Other"], ["last", "Last"]]
      : [["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"], ["d", "Delta"]];
    for (const [value, label] of definitions) {
      const option = new Option(label, value);
      select.add(option);
    }
    if (mode === "disabled") select.options[1].disabled = true;
    if (mode === "disabled-optgroup") {
      const group = document.createElement("optgroup");
      group.disabled = true;
      const disabled = new Option("Disabled group", "group-disabled");
      group.append(disabled);
      select.append(group);
    }
    if (mode === "disabled-current") select.options[1].disabled = true;
    if (mode === "custom") {
      select.remove();
      const custom = document.createElement("button");
      custom.id = "target";
      custom.dataset.testid = "target";
      custom.setAttribute("role", "combobox");
      custom.textContent = "Custom control";
      root.append(custom);
      return;
    }
    if (mode === "first-legend") {
      const fieldset = document.createElement("fieldset");
      fieldset.disabled = true;
      const legend = document.createElement("legend");
      legend.textContent = "Enabled legend control";
      legend.append(select);
      fieldset.append(legend);
      root.append(fieldset);
    } else {
      root.append(select);
    }
    if (mode === "single") select.options[0].selected = true;
    else if (mode === "disabled-current") select.options[1].selected = true;
    else select.options[0].selected = true;
    const wire = (control) => {
      control.addEventListener("input", () => {
        window.__r37Counts.input += 1;
        if (mode === "revert-input") {
          for (const option of control.options) option.selected = false;
          control.options[0].selected = true;
        }
      });
      control.addEventListener("change", () => {
        window.__r37Counts.change += 1;
        if (mode === "replace-change") {
          const replacement = control.cloneNode(true);
          replacement.dataset.replacement = "true";
          control.replaceWith(replacement);
        }
        if (mode === "disable-change") control.disabled = true;
      });
    };
    if (mode !== "disabled-select") wire(select);
    if (mode === "visualize-replace") {
      // Production operations run in an isolated world. Observe the shared
      // page DOM from the fixture's main world instead of overriding a DOM
      // method, whose main-world property is not guaranteed to be visible in
      // the isolated world.
      window.__r37VisualizeObserver = new MutationObserver(() => {
        if (!document.getElementById("__aos_companion_cursor__")) return;
        const current = document.querySelector("#target");
        if (!current || current.dataset.replacement === "true") return;
        const replacement = current.cloneNode(true);
        replacement.dataset.replacement = "true";
        current.replaceWith(replacement);
        window.__r37VisualizeObserver.disconnect();
      });
      window.__r37VisualizeObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  })()`);
}

const state = () => browser.evaluate(`({
  selected: [...document.querySelector("#target")?.options ?? []].filter(option => option.selected).map(option => ({ index: option.index, value: option.value, label: option.textContent })),
  controlDisabled: Boolean(document.querySelector("#target")?.disabled),
  counts: window.__r37Counts,
  controlConnected: Boolean(document.querySelector("#target")?.isConnected),
  replacement: document.querySelector("#target")?.dataset.replacement === "true",
})`);
const select = (option) => browser.productionOperation(injected, "selectOption", { locator: { testId: "target" }, option, timeoutMs: 1000 });
const inspect = () => browser.productionOperation(injected, "inspectDropdown", { locator: { testId: "target" } });

async function run(name, mode, body) {
  await setup(mode);
  try {
    receipt.cases.push({ name, mode, passed: true, ...await body() });
  } catch (error) {
    receipt.cases.push({ name, mode, passed: false, error: { message: error.message, code: error.code, details: error.details }, state: await state() });
  }
  console.log(JSON.stringify(receipt.cases.at(-1)));
}

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  browser = await isolatedBrowser({ binary });
  receipt.browser = browser.version;
  await browser.navigate(`http://127.0.0.1:${server.address().port}/`);

  await run("inspect exposes native multiple", "basic", async () => {
    const result = await inspect();
    assert.equal(result.controlKind, "native_select");
    assert.equal(result.multiple, true);
    assert.equal(result.element.multiple, true);
    return { inspection: { multiple: result.multiple, visibleOptionCount: result.visibleOptionCount } };
  });
  await run("noncontiguous selection replacement", "basic", async () => {
    const result = await select([{ index: 1 }, { index: 3 }]);
    assert.equal(result.selectionCommitted, true);
    assert.deepEqual(result.requestedSelection.map(option => option.index), [1, 3]);
    assert.deepEqual(result.actualSelection.map(option => option.index), [1, 3]);
    assert.deepEqual((await state()).selected.map(option => option.index), [1, 3]);
    assert.deepEqual((await state()).counts, { input: 1, change: 1 });
    return { requestedSelection: result.requestedSelection, actualSelection: result.actualSelection };
  });
  await run("replacement of a prior set", "basic", async () => {
    await select([{ index: 0 }, { index: 2 }]);
    const result = await select([{ label: "Beta" }, { label: "Delta" }]);
    assert.deepEqual(result.actualSelection.map(option => option.index), [1, 3]);
    assert.deepEqual((await state()).counts, { input: 2, change: 2 });
    return { actualSelection: result.actualSelection };
  });
  await run("empty array clears the selection", "basic", async () => {
    const result = await select([]);
    assert.equal(result.selectionCommitted, true);
    assert.deepEqual(result.requestedSelection, []);
    assert.deepEqual(result.actualSelection, []);
    assert.deepEqual((await state()).counts, { input: 1, change: 1 });
    return { actualSelection: result.actualSelection };
  });
  await run("unchanged selection is a no-op", "basic", async () => {
    await select([{ index: 0 }, { index: 2 }]);
    const before = await state();
    const result = await select([{ index: 0 }, { index: 2 }]);
    const after = await state();
    assert.equal(result.selectionCommitted, true);
    assert.equal(result.alreadySatisfied, true);
    assert.deepEqual(after, before);
    return { alreadySatisfied: result.alreadySatisfied, actualSelection: result.actualSelection };
  });
  await run("replacement during visual preflight fails before effect", "visualize-replace", async () => {
    await assert.rejects(select([{ index: 0 }]), error => {
      assert.equal(error.code, "dropdown_selection_target_changed");
      assert.equal(error.details?.operationEffectState, "none");
      assert.equal(error.details?.mutationDispatchAttempted, false);
      return true;
    });
    const after = await state();
    assert.equal(after.replacement, true);
    assert.deepEqual(after.counts, { input: 0, change: 0 });
    return { replacement: after.replacement, counts: after.counts };
  });
  await run("select inside a disabled fieldset legend remains enabled", "first-legend", async () => {
    const result = await select([{ index: 1 }]);
    assert.equal(result.selectionCommitted, true);
    assert.deepEqual((await state()).selected.map(option => option.index), [1]);
    assert.deepEqual((await state()).counts, { input: 1, change: 1 });
    return { actualSelection: result.actualSelection };
  });
  await run("duplicate values remain addressable by index", "duplicate", async () => {
    const result = await select([{ index: 0 }, { index: 3 }]);
    assert.deepEqual(result.actualSelection.map(option => option.index), [0, 3]);
    assert.deepEqual(result.actualSelection.map(option => option.value), ["dup", "dup"]);
    return { actualSelection: result.actualSelection };
  });
  for (const [name, mode, option, code] of [
    ["missing option rejects before dispatch", "basic", [{ label: "Missing" }], "dropdown_option_not_found"],
    ["ambiguous option rejects before dispatch", "ambiguous", [{ label: "Same" }], "dropdown_option_ambiguous"],
    ["disabled option rejects before dispatch", "disabled", [{ index: 1 }], "dropdown_option_disabled"],
    ["disabled optgroup option rejects before dispatch", "disabled-optgroup", [{ index: 4 }], "dropdown_option_disabled"],
    ["disabled current option cannot be toggled", "disabled-current", [], "dropdown_option_disabled"],
  ]) await run(name, mode, async () => {
    const before = await state();
    await assert.rejects(select(option), error => {
      assert.equal(error.code, code);
      assert.equal(error.details?.operationEffectState, "none");
      assert.equal(error.details?.mutationDispatchAttempted, false);
      return true;
    });
    assert.deepEqual(await state(), before);
    return { rejected: code };
  });
  await run("array rejects custom control without events", "custom", async () => {
    const before = await state();
    await assert.rejects(select([{ label: "Custom" }]), { code: "dropdown_option_array_unsupported" });
    assert.deepEqual(await state(), before);
    return { rejected: "dropdown_option_array_unsupported" };
  });
  await run("array rejects a single native select without events", "single", async () => {
    const before = await state();
    await assert.rejects(select([{ index: 1 }]), { code: "dropdown_option_array_unsupported" });
    assert.deepEqual(await state(), before);
    return { rejected: "dropdown_option_array_unsupported" };
  });
  await run("input driven reversion stops before change", "revert-input", async () => {
    await assert.rejects(select([{ index: 1 }, { index: 3 }]), error => {
      assert.equal(error.code, "dropdown_selection_not_committed");
      assert.equal(error.details?.phase, "after_input");
      assert.equal(error.details?.operationEffectState, "unknown");
      assert.equal(error.details?.mutationDispatchAttempted, true);
      return true;
    });
    const after = await state();
    assert.deepEqual(after.selected.map(option => option.index), [0]);
    assert.deepEqual(after.counts, { input: 1, change: 0 });
    return { counts: after.counts, selected: after.selected };
  });
  await run("change driven replacement fails without replay", "replace-change", async () => {
    await assert.rejects(select([{ index: 1 }, { index: 3 }]), error => {
      assert.equal(error.code, "dropdown_selection_not_committed");
      assert.equal(error.details?.phase, "after_change");
      assert.equal(error.details?.controlReplaced, true);
      return true;
    });
    const after = await state();
    assert.equal(after.replacement, true);
    assert.deepEqual(after.counts, { input: 1, change: 1 });
    return { counts: after.counts, replacement: after.replacement };
  });
  await run("change can disable a control after retaining selection", "disable-change", async () => {
    const result = await select([{ index: 1 }, { index: 3 }]);
    assert.equal(result.selectionCommitted, true);
    const after = await state();
    assert.deepEqual(after.selected.map(option => option.index), [1, 3]);
    assert.equal(after.controlDisabled, true);
    assert.deepEqual(after.counts, { input: 1, change: 1 });
    return { counts: after.counts, controlDisabled: after.controlDisabled, selected: after.selected };
  });
  receipt.result = receipt.cases.every((entry) => entry.passed) ? "passed" : "failed";
} catch (error) {
  receipt.result = "failed";
  receipt.error = { message: error.message, code: error.code };
} finally {
  if (browser) {
    await browser.close();
    receipt.cleanup.browserClosed = true;
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  receipt.cleanup.serverClosed = true;
  receipt.finishedAt = new Date().toISOString();
  const receiptPath = join(output, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: receipt.result, receipt: receiptPath }));
  if (receipt.result !== "passed") process.exitCode = 1;
}
