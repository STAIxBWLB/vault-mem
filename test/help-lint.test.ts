import { expect, test } from "bun:test";
import { helpLint, type LintEntry } from "../scripts/help-lint.ts";
import { COMMANDS, FLAG_DESCRIPTIONS, usageLines, wrapUsage } from "../src/commands-table.ts";
import { takeColorFlag, textOptions } from "../src/text-output.ts";

const ok: LintEntry = { name: "search", usage: "search <vault> <query> [--limit 1..500] [--json]", summary: "search notes by full text", examples: ["vmem search personal lanterns --limit 5"] };
// Descriptions limited to the fixture's flags, so keys for other commands do not count as names of missing flags.
const own: Record<string, string> = { "--limit": FLAG_DESCRIPTIONS["--limit"]!, "--json": FLAG_DESCRIPTIONS["--json"]!, "--color": FLAG_DESCRIPTIONS["--color"]!, "--ascii": FLAG_DESCRIPTIONS["--ascii"]! };
const lint = (entry: Partial<LintEntry>, descriptions: Record<string, string> = own) => helpLint([{ ...ok, ...entry }], descriptions, false);

test("the help lint passes on the command table, rendered on a pipe with and without COLUMNS", () => {
  expect(helpLint()).toEqual([]);
});

test("the help lint fails each rule it owns", () => {
  expect(lint({})).toEqual([]);
  expect(lint({ summary: "search notes; then more" })).toContainEqual(expect.stringContaining("semicolon"));
  expect(lint({ summary: "search notes." })).toContainEqual(expect.stringContaining("trailing period"));
  expect(lint({ summary: "the search command" })).toContainEqual(expect.stringContaining("imperative verb"));
  expect(lint({ summary: "search notes \u2014 fast" })).toContainEqual(expect.stringContaining("not ASCII"));
  expect(lint({ summary: "search ".repeat(12).trim() })).toContainEqual(expect.stringContaining("beside the widest name"));
  expect(lint({ examples: [] })).toContainEqual(expect.stringContaining("takes arguments but has no example"));
  expect(lint({ examples: ["vmem search a b", "vmem search a c", "vmem search a d"] })).toContainEqual(expect.stringContaining("more than two examples"));
  expect(lint({ examples: ["vmem serch personal x"] })).toContainEqual(expect.stringContaining("does not run vmem search"));
  expect(lint({ examples: ["vmem search personal x --type insight"] })).toContainEqual(expect.stringContaining("uses --type, which search does not take"));
  expect(lint({ usage: "search <vault> <query> [--frobnicate] [--json]", examples: ["vmem search a b"] })).toContainEqual(expect.stringContaining("flag --frobnicate has no description"));
  expect(lint({}, { ...own, "--no-such-flag": "x" })).toContainEqual(expect.stringContaining("--no-such-flag: names no flag of any command"));
  expect(lint({}, { ...own, "--limit": "like --no-such-flag" })).toContainEqual(expect.stringContaining("names missing flag --no-such-flag"));
  expect(lint({}, { ...own, "--limit": "x".repeat(47) })).toContainEqual(expect.stringContaining("over 46"));
});

test("a usage error prints the usage within 80 columns, or its short form", () => {
  for (const command of COMMANDS) for (const line of usageLines(command.name, undefined)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(usageLines("status", undefined)).toEqual(["Usage: vmem status [--json]"]);
  expect(usageLines("promote-from-amem", undefined)).toEqual(["Usage: vmem promote-from-amem <vault> [<mem-id>] [flags]"]);
  expect(usageLines(undefined, undefined)).toEqual(["Usage: vmem <command> [args]"]);
  expect(wrapUsage("vmem x <a> [--b B|-] [--c C]", 14)).toEqual(["vmem x <a>", "    [--b B|-]", "    [--c C]"]);
  const run = Bun.spawnSync([process.execPath, "bin/vmem.js", "new", "personal"], { env: { ...process.env, COLUMNS: "" }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(2);
  const err = run.stderr.toString().trimEnd().split("\n");
  expect(err[1]).toBe("Usage: vmem new <vault> <stem> --type TYPE --domain DOMAIN --topics A,B");
  expect(err.at(-1)).toBe("Run 'vmem help new' for details.");
  for (const line of err) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});

test("--ascii is a global flag like --color and forces ASCII markers", () => {
  expect(takeColorFlag(["status", "--ascii", "--json"])).toEqual({ args: ["status", "--json"], ascii: true });
  expect(takeColorFlag(["--ascii", "status", "--color=never"])).toEqual({ args: ["status"], color: "never", ascii: true });
  expect(takeColorFlag(["show", "v", "--", "--ascii"])).toEqual({ args: ["show", "v", "--", "--ascii"] });
  expect(() => takeColorFlag(["status", "--ascii", "--ascii"])).toThrow("--ascii: given more than once");
  expect(textOptions(undefined, { LANG: "en_US.UTF-8" }, {}, true).ascii).toBe(true);
  expect(textOptions(undefined, { LANG: "en_US.UTF-8" }).ascii).toBe(false);
});
