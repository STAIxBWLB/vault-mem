import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkRuleA, checkRuleB, collectMessages, HOLE, knownSurface, namesContinuation, readBaseline } from "../scripts/refusal-inventory.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "refusal-inventory", "src");
const surface = knownSurface();

test("the collector reads UsageError, Refusal and Error messages, template holes included", () => {
  const messages = collectMessages(FIXTURE);
  expect(messages.map(m => [m.file, m.kind])).toEqual([
    ["bad.ts", "UsageError"], ["bad.ts", "Error"], ["bad.ts", "Refusal"], ["bad.ts", "Error"], ["nested/good.ts", "Error"], ["nested/good.ts", "Error"],
  ]);
  expect(messages[1]!.text).toBe(`search: refused; use vmem search ${HOLE} --no-such-flag`);
  expect(messages[5]!.text).toBe("refused; run vmem help assertions purge or call vmem_assertions_purge");
});

test("AC1: a message naming a missing command, option or tool is a rule B finding", () => {
  expect(checkRuleB(collectMessages(FIXTURE), surface).map(f => [f.file, f.line, f.reference])).toEqual([
    ["bad.ts", 5, "vmem frobnicate <vault>"],
    ["bad.ts", 6, "vmem search --no-such-flag"],
    ["bad.ts", 7, "vmem_no_such_tool"],
  ]);
});

test("AC4: every message under src/ passes rule B", () => {
  const messages = collectMessages(join(import.meta.dir, "..", "src"));
  expect(messages.filter(m => /\bvmem[ _]/.test(m.text)).length).toBeGreaterThanOrEqual(34);
  expect(checkRuleB(messages, surface)).toEqual([]);
});

test("the CLI exits 1 and names each finding", () => {
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "refusal-inventory.ts"), FIXTURE]);
  expect(run.exitCode).toBe(1);
  const err = run.stderr.toString();
  expect(err).toContain("bad.ts:5: vmem frobnicate <vault>: no command of that name in COMMANDS or SPEC_COMMANDS");
  expect(err).toContain("refusal-inventory: 3 rule B finding(s)");
});

const RULE_A = join(import.meta.dir, "fixtures", "refusal-inventory", "rule-a");
const script = join(import.meta.dir, "..", "scripts", "refusal-inventory.ts");

test("namesContinuation: a next step after the cause, and rule ids only with a retry command or tool", () => {
  expect(namesContinuation("widget: refused")).toBe(false);
  expect(namesContinuation(`widget: refused; ${HOLE}`)).toBe(false);
  expect(namesContinuation("widget: refused; retry with a smaller widget")).toBe(true);
  expect(namesContinuation("V01, V09: widget rules violated; fix them")).toBe(false);
  expect(namesContinuation("V01: widget rule violated; retry with vmem check <vault> <file>")).toBe(true);
  expect(namesContinuation("L01: dead link; call vmem_lint")).toBe(true);
});

test("AC2: a new refusal with no continuation and no marker fails rule A; markers and baseline entries pass", () => {
  const messages = collectMessages(RULE_A);
  expect(messages.find(m => m.text === "widget: needs the owner")?.marker).toBe("human-authority");
  const { unnamed, stale } = checkRuleA(messages, readBaseline(join(RULE_A, "baseline.json")));
  expect(unnamed.map(m => m.text)).toEqual(["widget: refused", "V01, V09: widget rules violated"]);
  expect(stale).toEqual([]);
  const run = Bun.spawnSync(["bun", script, RULE_A, "--baseline", join(RULE_A, "baseline.json")]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain(`messages.ts:3: "widget: refused": names no continuation`);
  expect(run.stderr.toString()).toContain("refusal-inventory: 2 rule A finding(s), 0 stale baseline entries");
});

test("AC3: a baseline entry that matches no unnamed message is stale and fails", () => {
  const { stale } = checkRuleA(collectMessages(RULE_A), readBaseline(join(RULE_A, "stale.json")));
  expect(stale).toEqual([{ file: "messages.ts", message: "widget: this message was reworded" }]);
  // An entry for a message that now names a continuation is stale too.
  expect(checkRuleA([{ file: "a.ts", line: 1, kind: "Error", text: "a: refused; retry later" }], [{ file: "a.ts", message: "a: refused; retry later" }]).stale).toHaveLength(1);
  const run = Bun.spawnSync(["bun", script, RULE_A, "--baseline", join(RULE_A, "stale.json")]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain(`stale entry messages.ts: "widget: this message was reworded"`);
});

test("the src baseline is current: no unnamed message outside it and no stale entry", () => {
  const { unnamed, stale } = checkRuleA(collectMessages(join(import.meta.dir, "..", "src")), readBaseline(join(import.meta.dir, "..", "scripts", "refusal-inventory.baseline.json")));
  expect([unnamed, stale]).toEqual([[], []]);
});
