import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, details });

class Option {
  constructor(label, value, index, { disabled = false, parentElement = null } = {}) {
    this.textContent = label;
    this.value = value;
    this.index = index;
    this.disabled = disabled;
    this.parentElement = parentElement;
  }
  getAttribute(name) { return name === "aria-label" ? null : null; }
  matches(selector) { return selector === ":disabled" && this.disabled === true; }
}

const context = {
  HTMLOptionElement: Option,
  normalize: value => String(value ?? "").replace(/\s+/gu, " ").trim(),
  lower: value => String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase(),
  operationError: error,
};
vm.createContext(context);
const helperSource = source.slice(source.indexOf("  const optionLabel ="), source.indexOf("\n  const dropdownControlKind ="));
const helpers = vm.runInContext(`${helperSource}\n({ requestedOption, chooseOption, nativeOptionReport, nativeOptionDisabled, nativeSelectionError })`, context);

test("native multiple helpers preserve duplicate identity and disabled optgroup boundaries", () => {
  const control = { tagName: "SELECT" };
  const group = { tagName: "OPTGROUP", disabled: true, parentElement: control };
  const first = new Option("Duplicate", "same", 0);
  const second = new Option("Duplicate", "same", 1);
  const grouped = new Option("Grouped", "grouped", 2, { parentElement: group });
  assert.equal(helpers.chooseOption([first, second], helpers.requestedOption({ index: 1 }), true), second);
  assert.throws(() => helpers.chooseOption([first, second], helpers.requestedOption({ label: "Duplicate" }), true), { code: "dropdown_option_ambiguous" });
  assert.equal(helpers.nativeOptionDisabled(grouped, control), true);
  const report = helpers.nativeOptionReport(second);
  assert.equal(report.label, "Duplicate");
  assert.equal(report.value, "same");
  assert.equal(report.index, 1);
  const pre = helpers.nativeSelectionError("dropdown_option_disabled", "disabled", { option: helpers.nativeOptionReport(grouped) });
  assert.equal(pre.details.operationEffectState, "none");
  assert.equal(pre.details.mutationDispatchAttempted, false);
});
