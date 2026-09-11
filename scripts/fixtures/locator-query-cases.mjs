// Run against the actual injectedPageOperation function in a local browser
// document. The harness supplies that function directly from service-worker.js.
export async function runLocatorQueryCases(operation) {
  const fixture = document.getElementById("fixture");
  fixture.innerHTML = `<section id="panel"><button data-testid="save">Save</button><button>Save draft</button><button>save</button>
    <button hidden>Hidden choice</button><label>住所<input placeholder="番地" value="visible-form-value"></label>
    <a class="doc" href="/one" title="文書一">文書一</a><a class="doc" href="/two">文書二</a><a class="doc" href="/three">文書三</a>
    <article class="card"><h2>東京</h2><button>詳細</button></article><article class="card archived"><h2>大阪 終了</h2><button>詳細</button></article>
    <div id="shadow-host"></div><input type="password" value="dummy-password"><div id="attributes" data-secret="dummy-secret" data-state="ready"></div></section>`;
  fixture.querySelector("#shadow-host").attachShadow({ mode: "open" }).innerHTML = '<section class="shadow-panel"><button>影のボタン</button><a href="/shadow">影のリンク</a></section>';
  const results = [];
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const query = async params => {
    const result = await operation("query", params);
    if (result?.__aosCompanionError) throw Object.assign(new Error(result.__aosCompanionError.message), result.__aosCompanionError);
    return result;
  };
  async function check(name, run) {
    const started = performance.now();
    try { await run(); results.push({ name, passed: true, ms: performance.now() - started }); }
    catch (error) { results.push({ name, passed: false, error: error.message, code: error.code ?? null }); }
  }
  await check("exact matching preserves case", async () => {
    const result = await query({ locator: { role: "button", name: "Save", exact: true, within: { css: "#panel" } } });
    expect(result.count === 1 && result.matches[0].name === "Save", "exact name must exclude draft and lowercase");
  });
  await check("explicit partial matching keeps all candidates", async () => {
    const result = await query({ locator: { role: "button", name: "Save", exact: false } });
    expect(result.totalCount === 3, "partial matching should not silently prefer the exact candidate");
  });
  await check("legacy matching still prefers an exact candidate", async () => {
    const result = await query({ locator: { role: "button", name: "Save" } });
    expect(result.totalCount === 2, "legacy case-insensitive exact preference changed");
  });
  await check("regular expressions use their requested flags", async () => {
    const result = await query({ locator: { css: "#panel button", nameRegex: { pattern: "^Save(?: draft)?$", flags: "u" } } });
    expect(result.count === 2, "case-sensitive regular expression should match two controls");
  });
  await check("CSS and ancestor locators traverse open Shadow DOM", async () => {
    const result = await query({ locator: { css: "button", name: "影のボタン", within: { css: "#shadow-host" } } });
    expect(result.count === 1, "shadow host ancestor must be visible to the locator");
  });
  await check("descendant and negative text filters narrow cards", async () => {
    const result = await query({ locator: { css: "article.card", has: { role: "button", name: "詳細" }, hasNotText: "終了" } });
    expect(result.count === 1 && result.matches[0].text.includes("東京"), "filters must retain the Tokyo card");
    const negative = await query({ locator: { css: "article.card", hasNot: { css: "h2", hasText: "東京" } } });
    expect(negative.count === 1 && negative.matches[0].text.includes("大阪"), "negative descendant filter must retain Osaka");
  });
  await check("ordinal aliases and last apply after filtering", async () => {
    const nth = await query({ locator: { css: "a.doc", nth: 1 }, attributes: ["href"] });
    const last = await query({ locator: { css: "a.doc", last: true }, attributes: ["href"] });
    expect(nth.matches[0].attributes.href === "/two", "nth index is not the second link");
    expect(last.matches[0].attributes.href === "/three", "last index is not the third link");
  });
  await check("compound locators include non-interactive CSS candidates and nested relations", async () => {
    const result = await query({ locator: { allOf: [{ css: "article.card" }, { has: { css: "h2", hasText: "東京" } }] } });
    expect(result.count === 1 && result.matches[0].text.includes("東京"), "compound CSS and descendant filters lost the Tokyo article");
    const alternatives = await query({ locator: { anyOf: [{ css: "article", has: { css: "h2", hasText: "東京" } }, { role: "button", name: "Save draft", exact: true }] } });
    expect(alternatives.count === 2, "alternative constraints must retain both matching element types");
  });
  await check("attributes return null for absence and pagination reports remaining results", async () => {
    const result = await query({ locator: { css: "a.doc" }, attributes: ["href", "title"], limit: 1, offset: 1 });
    expect(result.totalCount === 3 && result.count === 1 && result.nextOffset === 2 && result.truncated, "pagination counts are wrong");
    expect(result.matches[0].attributes.href === "/two" && result.matches[0].attributes.title === null, "attribute readback mismatch");
  });
  await check("nested position constraints are rejected rather than ignored", async () => {
    const result = await operation("query", { locator: { css: "article", has: { css: "h2", nth: 1 } } });
    expect(result.__aosCompanionError?.code === "semantic_locator_index_invalid", "nested position must not silently match every article");
  });
  await check("hidden reads require an explicit option", async () => {
    const params = { locator: { css: "button[hidden]" } };
    expect((await query(params)).count === 0, "hidden element leaked into default results");
    expect((await query({ ...params, includeHidden: true })).count === 1, "explicit hidden read missing");
  });
  await check("sensitive attributes and form values remain redacted", async () => {
    const result = await query({ locator: { css: "#attributes" }, attributes: ["data-secret", "data-state"] });
    expect(result.matches[0].attributes["data-secret"] === "<redacted>" && result.matches[0].attributes["data-state"] === "ready", "attribute redaction mismatch");
    const password = await query({ locator: { css: 'input[type="password"]' }, attributes: ["value"] });
    expect(password.matches[0].attributes.value === "<redacted>", "password attribute must be redacted");
    expect(!JSON.stringify(password).includes("dummy-password"), "password value must not leak through the accessible name or text");
  });
  await check("attribute output truncation is explicit", async () => {
    fixture.querySelector("#attributes").setAttribute("data-long", "x".repeat(2500));
    const result = await query({ locator: { css: "#attributes" }, attributes: ["data-long"] });
    expect(result.matches[0].attributes["data-long"].length === 2000 && result.matches[0].truncatedAttributes.includes("data-long"), "attribute truncation is missing");
  });
  await check("invalid selectors and regex return actionable errors", async () => {
    const css = await operation("query", { locator: { css: "[" } });
    const regex = await operation("query", { locator: { css: "button", nameRegex: { pattern: "[", flags: "u" } } });
    expect(css.__aosCompanionError?.code === "semantic_selector_invalid", "invalid CSS lost its error code");
    expect(regex.__aosCompanionError?.code === "semantic_regex_invalid", "invalid regex lost its error code");
  });
  await check("ambiguous mutation targets do not choose the first candidate", async () => {
    const result = await operation("inspectVisualTarget", { locator: { css: "#panel > button" }, scroll: false });
    expect(result.__aosCompanionError?.code === "semantic_locator_ambiguous", "ambiguous visual target must fail");
  });
  await check("CSS locator changes exactly one local input", async () => {
    const value = "東京都 1-2-3 👩🏽‍💻";
    const result = await operation("type", { locator: { css: 'input[placeholder="番地"]' }, text: value, clear: true });
    expect(!result.__aosCompanionError && fixture.querySelector('input[placeholder="番地"]').value === value, "CSS input did not commit Japanese text");
  });
  const editor = document.createElement("div");
  editor.id = "multiline-editor";
  editor.contentEditable = "true";
  editor.style.cssText = "min-height:60px;border:1px solid #abc;padding:10px;white-space:normal";
  fixture.appendChild(editor);
  for (const [name, text] of [["two lines", "比較用の文章\n二行目も保持"], ["blank line", "一行目\n\n三行目"], ["trailing newline", "末尾の改行\n"], ["empty editor", ""]]) {
    await check("rendered contenteditable replacement preserves " + name, async () => {
      const result = await operation("type", { locator: { css: "#multiline-editor" }, text, clear: true, clearExplicit: true });
      expect(!result.__aosCompanionError, JSON.stringify(result.__aosCompanionError));
      expect(editor.innerText === text, "rendered text mismatch: " + JSON.stringify(editor.innerText));
      expect(result.semanticCommitted === true, "replacement was not verified");
      const readback = await operation("verifyTypeValue", { locator: { css: "#multiline-editor" }, expectedText: text });
      expect(readback.committed === true, "value readback does not match rendered text");
    });
  }
  await check("append retains existing rich text and inserts real newlines", async () => {
    editor.innerHTML = "<strong>既存の太字</strong>";
    const result = await operation("type", { locator: { css: "#multiline-editor" }, text: "\n追加の行", clear: false });
    expect(result.semanticCommitted && editor.innerText === "既存の太字\n追加の行", "append lost lines or content");
    expect(editor.querySelector("strong")?.textContent === "既存の太字", "existing formatting was removed");
  });
  await check("wait probes expose absent and invalid targets without swallowing their errors", async () => {
    const absent = await operation("waitFor", { locator: { css: "#does-not-exist" } });
    expect(absent.found === false, "missing element was not reported");
    const ambiguous = await operation("waitFor", { locator: { css: "a.doc" } });
    expect(ambiguous.__aosCompanionError?.code === "semantic_locator_ambiguous", "ambiguous locator was retried as absent");
    const invalid = await operation("waitFor", { locator: { css: "[" } });
    expect(invalid.__aosCompanionError?.code === "semantic_selector_invalid", "invalid CSS error was swallowed");
  });
  await check("physical replacement verification requires the complete focused input selection", async () => {
    const input = fixture.querySelector('input[placeholder="番地"]');
    input.scrollIntoView({ block: "center" }); input.focus();
    const rect = input.getBoundingClientRect(); const point = { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
    input.setSelectionRange(3, 5);
    expect((await operation("verifyTypeSelection", { point })).selectedAll === false, "partial selection was accepted");
    input.select();
    expect((await operation("verifyTypeSelection", { point })).selectedAll === true, "complete input selection was rejected");
    editor.focus();
    const changed = await operation("verifyTypeValue", { point, expectedText: input.value });
    expect(changed.__aosCompanionError?.code === "physical_input_target_changed", "focus change was ignored");
  });
  await check("physical editor selection supports Text-node boundaries and rejects partial text", async () => {
    editor.innerHTML = "<strong>既存の太字</strong>と末尾";
    editor.scrollIntoView({ block: "center" }); editor.focus();
    const rect = editor.getBoundingClientRect(); const point = { x: rect.x + 10, y: rect.y + 10 };
    const range = document.createRange();
    range.setStart(editor.querySelector("strong").firstChild, 0);
    range.setEnd(editor.lastChild, editor.lastChild.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    expect((await operation("verifyTypeSelection", { point })).selectedAll === true, "complete text boundaries were rejected");
    range.setStart(editor.querySelector("strong").firstChild, 1);
    expect((await operation("verifyTypeSelection", { point })).selectedAll === false, "partial editor text was accepted");
  });
  const uploads = document.createElement("section");
  uploads.innerHTML = '<label>検証ファイル<input type="file" multiple aria-label="検証ファイル"></label><label>隠れた添付<input type="file" hidden aria-label="隠れた添付"></label>';
  fixture.append(uploads);
  const file = { name: "日本語.txt", mimeType: "text/plain", dataBase64: btoa("fixture contents"), sha256: "fixture" };
  await check("upload label resolves the file input instead of its label element", async () => {
    const result = await operation("upload", { locator: { label: "検証ファイル" }, file });
    expect(result.uploaded === true, JSON.stringify(result));
    expect(await uploads.querySelector("input").files[0].text() === "fixture contents", "file contents changed");
  });
  await check("multiple upload keeps the requested count and file contents", async () => {
    const result = await operation("uploadMultiple", { locator: { label: "検証ファイル" }, files: [file, { ...file, name: "追加.txt" }] });
    expect(result.uploaded && result.count === 2, JSON.stringify(result));
    expect(await uploads.querySelector("input").files[1].text() === "fixture contents", "second file contents changed");
  });
  await check("hidden file controls remain reachable by their visible label", async () => {
    const result = await operation("upload", { locator: { label: "隠れた添付" }, file });
    expect(result.uploaded === true, JSON.stringify(result));
  });
  await check("ambiguous file controls are a verified pre-assignment failure", async () => {
    const duplicate = uploads.querySelector("input").cloneNode(); uploads.append(duplicate);
    const before = [...uploads.querySelectorAll("input")].map(input => [...input.files].map(file => ({ name: file.name, size: file.size })));
    const result = await operation("upload", { locator: { label: "検証ファイル" }, file });
    expect(result.__aosCompanionError?.code === "semantic_locator_ambiguous", "multiple file inputs were not rejected");
    expect(result.__aosCompanionError.details.mutationDispatchAttempted === false && result.__aosCompanionError.details.operationEffectState === "none", "pre-assignment failure became unknown");
    const after = [...uploads.querySelectorAll("input")].map(input => [...input.files].map(file => ({ name: file.name, size: file.size })));
    expect(JSON.stringify(after) === JSON.stringify(before), "ambiguous operation changed files");
    duplicate.remove();
  });
  await check("invalid upload payload is rejected before file assignment", async () => {
    const result = await operation("uploadMultiple", { locator: { label: "検証ファイル" }, files: [{ name: "bad" }] });
    expect(result.__aosCompanionError?.details.mutationDispatchAttempted === false, "invalid payload lost pre-assignment evidence");
    expect(uploads.querySelector("input").files.length === 2, "invalid payload changed files");
  });
  return { schema: "aos.chrome_companion.locator_dom_cases.v1", passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length, cases: results, url: location.href };
}
