import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const error = (code, message) => Object.assign(new Error(message), { code });

test("visual modifier strings accept lowercase shift and whitespace without losing letters", () => {
  const context = { companionError: error }; vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("function visualModifiers("), source.indexOf("\nasync function dispatchMouseClick(")), context);
  for (const value of ["Meta+Shift", "meta shift", "meta,shift", ["meta", "shift"]]) {
    const result = context.visualModifiers(value);
    assert.equal(result.bits, 12);
    assert.equal(result.values.join(","), "meta,shift");
  }
  assert.equal(context.visualModifiers("shift").bits, 8);
  assert.equal(context.visualModifiers("ctrl\tshift").bits, 10);
  assert.throws(() => context.visualModifiers("unsupported"), { code: "visual_modifier_not_allowed" });
});

class Option {
  constructor(value, label) { this.value = value; this.textContent = label; }
  getAttribute() { return null; }
}
const normalize = value => String(value ?? "").replace(/\s+/gu, " ").trim();
const context = { HTMLOptionElement: Option, normalize, lower: value => normalize(value).toLowerCase(), operationError: error };
vm.createContext(context);
const { requestedOption, chooseOption } = vm.runInContext(source.slice(source.indexOf("  const optionLabel ="), source.indexOf("\n  const dropdownControlKind =")) + "\n({requestedOption,chooseOption})", context);

test("an explicit empty dropdown value selects the placeholder instead of becoming an absent constraint", () => {
  const empty = new Option("", "選択を解除");
  const choices = [new Option("yes", "はい"), empty, new Option("no", "いいえ")];
  for (const exact of [true, false]) assert.equal(chooseOption(choices, requestedOption({ value: "" }), exact), empty);
  assert.equal(chooseOption(choices, requestedOption({ index: 2 }), true), choices[2]);
  assert.equal(chooseOption(choices, requestedOption("はい"), true), choices[0]);
});

test("empty dropdown values preserve ambiguity and invalid option requests cannot pick a default", () => {
  assert.throws(() => chooseOption([new Option("", "A"), new Option("", "B")], requestedOption({ value: "" }), false), { code: "dropdown_option_ambiguous" });
  for (const input of [{}, { value: "", label: "A" }, { index: -1 }, { index: 1.5 }]) assert.throws(() => requestedOption(input));
});
