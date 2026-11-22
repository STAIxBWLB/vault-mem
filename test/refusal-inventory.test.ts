import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkRuleB, collectMessages, HOLE, knownSurface } from "../scripts/refusal-inventory.ts";

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
