import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { mergeSemanticSnapshotResults } from "../extension/semantic-snapshot.js";

function createHelperHarness(source, executeScript) {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const injectedPageOperation = () => {};
  const context = vm.createContext({
    chrome: { scripting: { executeScript } },
    clearTimeout: timerId => timers.delete(timerId),
    injectedPageOperation,
    setTimeout: (callback, delay) => {
      const timerId = ++nextTimerId;
      timers.set(timerId, { callback, dueAt: now + delay });
      return timerId;
    },
  });
  const timeoutStart = source.indexOf("function timeoutError(");
  const helperStart = source.indexOf("async function executePageScriptWithReadRetry(");
  const helperEnd = source.indexOf("\n// `chrome.scripting.executeScript` returns", helperStart);
  assert.ok(timeoutStart >= 0 && helperStart >= 0 && helperEnd >= 0, "bounded helper source should be present");
  const timeoutSource = source.slice(timeoutStart, source.indexOf("const READ_ONLY_PAGE_ACTIONS", timeoutStart));
  const helperSource = source.slice(helperStart, helperEnd);
  vm.runInContext(`${timeoutSource}\nconst READ_API_TIMEOUT_MS = 10_000;\n${helperSource}\nglobalThis.runHelper = executePageScriptWithReadRetry;`, context);
  return {
    run: (...args) => context.runHelper(...args),
    advance: async (milliseconds) => {
      now += milliseconds;
      for (const [timerId, timer] of [...timers]) {
        if (timer.dueAt <= now) {
          timers.delete(timerId);
          timer.callback();
        }
      }
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    },
    injectedPageOperation,
  };
}

async function readPageScriptHelper() {
  return readFile(resolve("extension/service-worker.js"), "utf8");
}

function selectionFixture(source, { text = "alpha beta", children, focus, afterSelection } = {}) {
  const textNode = value => ({ nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] });
  const node = (tag, attributes = {}, childNodes = []) => {
    const element = { nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(), childNodes,
      attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
      getAttribute(name) { return this.attributes.find(attribute => attribute.name === name)?.value ?? null; },
      get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join(""); },
      get innerText() { return this.textContent; },
    };
    for (const child of childNodes) child.parentElement = element;
    return element;
  };
  const highlight = (...values) => node("span", { class: "highlight" }, values.map(value => typeof value === "string" ? textNode(value) : value));
  const editor = node("div", { contenteditable: "true" }, children?.({ node, textNode, highlight }) ?? [textNode(text)]);
  Object.assign(editor, { isConnected: true, isContentEditable: true, scrollIntoView() {}, focus() { focus?.(api); } });
  const texts = () => {
    const result = [];
    const visit = item => item.nodeType === 3 ? result.push(item) : item.childNodes.forEach(visit);
    visit(editor);
    return result;
  };
  const offsetOf = (container, offset) => {
    let total = 0, found;
    const visit = item => {
      if (item.nodeType === 3) { if (item === container) found = total + offset; total += item.nodeValue.length; }
      else for (let index = 0; index <= item.childNodes.length; index++) {
        if (item === container && index === offset) found = total;
        if (index < item.childNodes.length) visit(item.childNodes[index]);
      }
    };
    visit(editor);
    return found;
  };
  let selectedRange;
  const range = () => ({
    setStart(container, offset) { this.startContainer = container; this.startOffset = offset; },
    setEnd(container, offset) { this.endContainer = container; this.endOffset = offset; },
    selectNodeContents() {}, getClientRects() { return [{}]; },
  });
  const selection = {
    get rangeCount() { return selectedRange ? 1 : 0; }, removeAllRanges() { selectedRange = null; },
    addRange(value) { selectedRange = value; }, getRangeAt() { return selectedRange; },
    toString() { return selectedRange ? editor.textContent.slice(offsetOf(selectedRange.startContainer, selectedRange.startOffset), offsetOf(selectedRange.endContainer, selectedRange.endOffset)) : ""; },
  };
  const selectOffsets = (start, end) => {
    selectedRange = range();
    let total = 0;
    for (const item of texts()) {
      const next = total + item.nodeValue.length;
      if (start >= total && start < next) selectedRange.setStart(item, start - total);
      if (end > total && end <= next) selectedRange.setEnd(item, end - total);
      total = next;
    }
  };
  const api = { editor, node, textNode, highlight, selection, selectOffsets,
    replace(childNodes) {
      const start = selectedRange && offsetOf(selectedRange.startContainer, selectedRange.startOffset);
      const end = selectedRange && offsetOf(selectedRange.endContainer, selectedRange.endOffset);
      editor.childNodes = childNodes;
      childNodes.forEach(child => { child.parentElement = editor; });
      if (selectedRange) selectOffsets(start, end);
    },
  };
  const context = {
    NodeFilter: { SHOW_TEXT: 4 }, find: () => editor, describe: () => ({}), boxOf: (element) => element.getBoundingClientRect(), scrollTargetOf: (element) => element,  location: { href: "https://editor.test/" },
    getSelection: () => selection, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    visualize: async () => {}, wait: async () => afterSelection?.(api),
    operationError: (code, message) => Object.assign(new Error(message), { code }),
    document: { createRange: range, createTreeWalker: () => {
      const entries = texts(); let index = -1;
      return { get currentNode() { return entries[index]; }, nextNode() { return ++index < entries.length; } };
    } },
  };
  const start = source.indexOf('  if (action === "selectText") {');
  const end = source.indexOf('  const richTextStructure =', start);
  assert.ok(start >= 0 && end > start);
  vm.createContext(context);
  vm.runInContext(`async function selectText(payload) { let selectionObservedChange = false, selectionMutationAttempted = false; const action = "selectText"; ${source.slice(start, end)} }`, context);
  return { ...api, run: payload => context.selectText({ locator: {}, text, ...payload }) };
}

test("exact text selection survives split and nested highlight decoration before and after dispatch", async () => {
  const source = await readPageScriptHelper();
  for (const phase of ["focus", "afterSelection"]) {
    const fixture = selectionFixture(source, { [phase]: api => api.replace([api.textNode("al"), api.highlight("pha ", api.highlight("be")), api.highlight("ta")]) });
    const result = await fixture.run({ text: "beta" });
    assert.equal(result.selectionCommitted, true);
    assert.equal(result.contentPreserved, true);
    assert.equal(fixture.selection.toString(), "beta");
  }
});

test("selection keeps UTF-16 offsets across decoration and rejects a different duplicate occurrence", async () => {
  const source = await readPageScriptHelper();
  const utf16 = selectionFixture(source, { text: "😀日本😀", afterSelection: api => api.replace([api.highlight("\ud83d"), api.highlight("\ude00日", api.highlight("本")), api.textNode("😀")]) });
  assert.equal((await utf16.run({ text: "日本" })).selectedTextLength, 2);
  assert.equal(utf16.selection.toString(), "日本");
  const duplicate = selectionFixture(source, { text: "same same", afterSelection: api => { api.replace([api.highlight("same "), api.highlight("same")]); api.selectOffsets(0, 4); } });
  await assert.rejects(duplicate.run({ text: "same", occurrence: 1 }), { code: "selection_not_committed" });
  const correct = selectionFixture(source, { text: "same same", afterSelection: api => api.replace([api.highlight("same "), api.highlight("same")]) });
  assert.equal((await correct.run({ text: "same", occurrence: 1 })).occurrence, 1);
  const ambiguous = selectionFixture(source, { text: "same same" });
  await assert.rejects(ambiguous.run({ text: "same" }), { code: "selection_text_ambiguous" });
});

test("selection accepts equivalent element boundaries after decoration", async () => {
  const fixture = selectionFixture(await readPageScriptHelper(), { afterSelection: api => {
    api.replace([api.highlight("alpha "), api.highlight("beta")]);
    api.selection.getRangeAt(0).setStart(api.editor, 1);
    api.selection.getRangeAt(0).setEnd(api.editor, 2);
  } });
  assert.equal((await fixture.run({ text: "beta" })).selectionCommitted, true);
});

test("selection rejects real text and non-eligible decoration changes in either phase", async () => {
  const source = await readPageScriptHelper();
  for (const phase of ["focus", "afterSelection"]) {
    for (const change of [
      api => api.replace([api.textNode("alpha BETA")]),
      api => api.replace([api.node("span", { class: "highlight", title: "extra" }, [api.textNode("alpha beta")])]),
      api => api.replace([api.node("span", { class: "highlight other" }, [api.textNode("alpha beta")])]),
      api => api.replace([api.node("span", { class: "highlight" }, [api.node("b", {}, [api.textNode("alpha beta")])])]),
    ]) {
      const fixture = selectionFixture(source, { [phase]: change });
      await assert.rejects(fixture.run({ text: "beta" }), { code: phase === "focus" ? "selection_editor_changed_before_dispatch" : "selection_editor_content_changed" });
    }
  }
});

test("selection protects semantic identity, attributes and order even when exact text is unchanged", async () => {
  const source = await readPageScriptHelper();
  for (const change of [
    api => api.replace([api.node("b", {}, [api.textNode("same")]), api.editor.childNodes[1]]),
    api => { api.editor.childNodes[0].attributes.push({ name: "title", value: "changed" }); },
    api => api.replace([...api.editor.childNodes].reverse()),
    api => { api.editor.attributes.push({ name: "aria-label", value: "changed" }); },
  ]) {
    const fixture = selectionFixture(source, {
      children: ({ node, textNode }) => [node("b", {}, [textNode("same")]), node("i", {}, [textNode("same")])],
      afterSelection: change,
    });
    await assert.rejects(fixture.run({ text: "same", occurrence: 0 }), { code: "selection_editor_content_changed" });
  }
});

test("semantic snapshots merge meaningful iframe content when the main frame is empty", () => {
  const snapshot = mergeSemanticSnapshotResults([
    { frameId: 0, result: { url: "https://example.test/", title: "Shell", readyState: "complete", pageInstanceId: "main-doc", text: "", controls: [] } },
    { frameId: 4, result: { url: "https://form.example.test/", title: "Form", readyState: "complete", pageInstanceId: "frame-doc", text: "応募フォーム", controls: [{ tag: "button", role: "button", name: "送信" }] } },
  ], 30_000);
  assert.equal(snapshot.url, "https://example.test/");
  assert.equal(snapshot.text, "応募フォーム");
  assert.equal(snapshot.controls[0].frameId, 4);
  assert.equal(snapshot.frames[1].url, "https://form.example.test/");
  assert.equal(snapshot.frames[1].pageInstanceId, "frame-doc");
  assert.equal(snapshot.frameCount, 2);
  assert.equal(snapshot.semanticEmpty, false);
});

test("semantic snapshots stay bounded and report a truly empty multi-frame result", () => {
  const bounded = mergeSemanticSnapshotResults([
    { frameId: 0, result: { url: "https://example.test/", title: "Bounded", readyState: "complete", text: "abcdef", controls: [] } },
  ], 4);
  assert.equal(bounded.text, "abcd");
  const empty = mergeSemanticSnapshotResults([
    { frameId: 0, result: { url: "https://example.test/", title: "Empty", readyState: "complete", text: "", controls: [] } },
    { frameId: 2, result: { url: "https://frame.example.test/", title: "Empty frame", readyState: "complete", text: "", controls: [] } },
  ]);
  assert.equal(empty.semanticEmpty, true);
});

test("extension snapshot execution covers all frames and open shadow roots", async () => {
  const source = await readPageScriptHelper();
  assert.match(source, /allFrames: true/);
  assert.match(source, /frameIds: \[requestedFrameId\]/);
  assert.match(source, /target_frame_origin_not_allowed/);
  assert.match(source, /element\.shadowRoot/);
  assert.match(source, /querySemantic/);
  assert.match(source, /valuePresent/);
});

test("page read helper succeeds once with the existing execute options and result", async () => {
  const result = [{ result: { text: "ok" } }];
  const calls = [];
  const harness = createHelperHarness(await readPageScriptHelper(), options => {
    calls.push(options);
    return Promise.resolve(result);
  });
  const target = { tabId: 7, frameIds: [0] };
  const payload = { selector: "main" };

  assert.strictEqual(await harness.run(target, "snapshot", payload), result);
  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0].target, target);
  assert.equal(calls[0].world, "ISOLATED");
  assert.strictEqual(calls[0].func, harness.injectedPageOperation);
  assert.equal(calls[0].args.length, 2);
  assert.equal(calls[0].args[0], "snapshot");
  assert.strictEqual(calls[0].args[1], payload);
});

test("page read helper times out once without retrying a never-resolving injection", async () => {
  const calls = [];
  const harness = createHelperHarness(await readPageScriptHelper(), options => {
    calls.push(options);
    return new Promise(() => {});
  });
  let settled = false;
  const outcome = harness.run({ tabId: 1 }, "snapshot", {}).catch(error => {
    settled = true;
    return error;
  });

  await harness.advance(9_999);
  assert.equal(settled, false);
  assert.equal(calls.length, 1);
  await harness.advance(1);
  const error = await outcome;
  assert.equal(error.code, "page_execution_timeout");
  assert.equal(error.message, "Chrome did not return a semantic page result within the bounded read window");
  await harness.advance(60_000);
  assert.equal(calls.length, 1);
});

test("page read helper preserves a settled rejection without retrying", async () => {
  const originalError = new Error("original rejection");
  let calls = 0;
  const harness = createHelperHarness(await readPageScriptHelper(), () => {
    calls += 1;
    return Promise.reject(originalError);
  });

  await assert.rejects(harness.run({ tabId: 2 }, "snapshot", {}), error => {
    assert.strictEqual(error, originalError);
    return true;
  });
  await harness.advance(120);
  assert.equal(calls, 1);
});

test("late page resolution or rejection after timeout cannot reinject or change the outcome", async () => {
  for (const lateOutcome of ["resolve", "reject"]) {
    let calls = 0;
    let settleLate;
    const lateError = new Error("late rejection");
    const latePromise = new Promise((resolve, reject) => {
      settleLate = lateOutcome === "resolve" ? resolve : reject;
    });
    const harness = createHelperHarness(await readPageScriptHelper(), () => {
      calls += 1;
      return latePromise;
    });
    const unhandled = [];
    const onUnhandledRejection = reason => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const outcome = harness.run({ tabId: 3 }, "snapshot", {});
      await harness.advance(10_000);
      const timeout = await outcome.catch(error => error);
      assert.equal(timeout.code, "page_execution_timeout");
      settleLate(lateOutcome === "resolve" ? [{ result: "late" }] : lateError);
      await harness.advance(60_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(timeout.code, "page_execution_timeout");
      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
  }
});
