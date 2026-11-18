import { expect, test } from "bun:test";
import { errorLine, paint, marker, resolveColor, stripTerminal, table, textOptions, width } from "../src/text-output.ts";
import { run } from "../src/cli.ts";
import { evidenceText } from "../src/read-output.ts";
import { renderStatus } from "../src/cli-output.ts";

const plain = { color: false, ascii: true };
const color = { color: true, ascii: true };
test("shared roles and markers render a report with and without color", () => {
  const report = (o: typeof plain) => [paint("vmem report", "header", o), `${marker("ok", o)} healthy`, `${marker("fail", o)} failed`].join("\n");
  expect(report(plain)).toBe("vmem report\nok healthy\nx  failed");
  expect(stripTerminal(report(color))).toBe(report(plain));
  expect(report(color)).toBe([paint("vmem report", "header", color), `${paint("ok", "success", color)} healthy`, `${paint("x ", "error", color)} failed`].join("\n"));
  expect(new Set(["header", "section", "key", "success", "warning", "error", "hint", "accent"].map(role => paint("x", role as "header", color))).size).toBe(8);
  const roles = ["header", "section", "key", "value", "success", "warning", "error", "hint", "accent"] as const;
  const codes = roles.map(role => paint("sample", role, color).match(/\[([0-9;]+)m/)?.[1] ?? "default");
  expect(codes).toEqual(["1;34", "1;35", "34", "default", "1;32", "1;33", "1;31", "90", "36"]);
});
test("status report is golden with color off and on", () => {
  const report = { home: "/synthetic", source: "VMEM_HOME" as const, version: "9.0.0", healthy: true, vaults: [] };
  const expected = "vmem 9.0.0  home /synthetic (VMEM_HOME)  ok healthy\n\nno vaults registered; add one with vmem vaults add <id> <absolute-path> --kind personal|org --write mcp|cli|none";
  expect(renderStatus(report, plain)).toBe(expected);
  const colored = renderStatus(report, color);
  expect(stripTerminal(colored)).toBe(expected);
  expect([...colored.matchAll(/\[([0-9;]+)m/g)].map(match => match[1])).toEqual(["1;34", "0", "1;32", "0", "1;32", "0"]);
});
test("color precedence and JSON on pipes", () => {
  const env = { isTTY: false, TERM: "dumb", FORCE_COLOR: "1" };
  expect(resolveColor("auto", env)).toBe(true);
  expect(resolveColor("auto", { ...env, NO_COLOR: "1" })).toBe(false);
  expect(resolveColor("always", { ...env, NO_COLOR: "1" })).toBe(true);
  expect(resolveColor("never", env)).toBe(false);
  expect(resolveColor("auto", { isTTY: true, FORCE_COLOR: "0" })).toBe(false);
  expect(resolveColor("auto", { isTTY: false, CLICOLOR_FORCE: "1", CLICOLOR: "0" })).toBe(true);
  expect(resolveColor("auto", { isTTY: true, CLICOLOR: "0" })).toBe(false);
  const json = run(["manifest", "--json", "--color=always"], { FORCE_COLOR: "1", LANG: "C" }).text;
  expect(stripTerminal(json)).toBe(json);
  expect(JSON.parse(json).name).toBe("@staix/vault-mem");
});
test("80-column reports cap fixed columns and keep state on one line", () => {
  const output = table(["ID", "STATE", "FINDING"], [["long-id-".repeat(10), "failed", "a long finding ".repeat(12)]], { color: false, columns: 80 });
  for (const line of output.split("\n")) expect(width(line)).toBeLessThanOrEqual(80);
  expect(output).toContain("failed");
  expect(output).toContain("...");
  const piped = table(["LABEL", "RESULT"], [["alpha beta gamma delta epsilon zeta eta theta", "done"]], plain);
  expect(piped).toContain("alpha beta gamma delta epsilon");
  expect(piped).toContain("zeta eta theta");
});
test("LANG=C selects ASCII markers", () => {
  const options = textOptions("never", { LANG: "C" });
  expect(marker("ok", options)).toBe("ok");
  expect(marker("fail", options)).toBe("x ");
  expect(marker("next", options)).toBe("->");
  expect(marker("ok", textOptions("never", { LANG: "C.UTF-8" }))).toBe("✓ ");
});
test("stderr decides color independently of stdout", () => {
  const env = { LANG: "C.UTF-8", TERM: "xterm" };
  const stdout = textOptions("auto", env, { isTTY: false });
  const stderr = textOptions("auto", env, { isTTY: true });
  expect(stdout.color).toBe(false);
  expect(stderr.color).toBe(true);
  expect(stripTerminal(errorLine("failed", stderr, true))).toBe("✗  vmem: failed");
  expect(errorLine("failed", stdout, false)).toBe("vmem: failed");
  const forced = textOptions("auto", { ...env, FORCE_COLOR: "1" }, { isTTY: false });
  expect(errorLine("failed", forced, false)).not.toBe(errorLine("failed", stdout, false));
  expect(stripTerminal(errorLine("failed", forced, false))).toBe("vmem: failed");
});

test("usage and operation failures have distinct process exits", () => {
  const bin = new URL("../bin/vmem.js", import.meta.url).pathname;
  const env = { ...process.env, LANG: "C", VMEM_HOME: "/nonexistent-vmem-test-home" };
  for (const args of [["lint"], ["check"], ["not-a-command"], ["lint", "--bad"], ["status", "extra"], ["search"], ["log"], ["sync"], ["graph", "path"], ["spec", "unknown"], ["skills", "unknown"], ["brief"], ["brief", "--bad"], ["brief", "v", "--for", "x", "--bytes", "2"], ["skills", "mine", "v", "--days", "0"], ["tidy", "v"], ["check", "v", "-", "--unknown"]]) {
    const result = Bun.spawnSync([process.execPath, bin, ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("vmem: ");
  }
  const failure = Bun.spawnSync([process.execPath, bin, "lint", "missing"], { env, stdout: "pipe", stderr: "pipe" });
  expect(failure.exitCode).toBe(1);
  expect(failure.stderr.toString()).toContain("vmem: ");
  const multi = Bun.spawnSync([process.execPath, bin, "graph", "path"], { env, stdout: "pipe", stderr: "pipe" });
  expect(multi.stderr.toString().split("\n").slice(-3)).toEqual([
    "Usage: vmem graph path <vault> <from> <to> [--max-hops 1..6] [--relation REL] [--via-hubs] [--json]",
    "Run 'vmem help graph path' for details.", "",
  ]);
  const unknown = Bun.spawnSync([process.execPath, bin, "not-a-command"], { env, stdout: "pipe", stderr: "pipe" });
  expect(unknown.stderr.toString()).toEndWith("Usage: vmem <command> [args]\nRun 'vmem help' for details.\n");
  const registry = Bun.spawnSync([process.execPath, bin, "vaults", "add"], { env, stdout: "pipe", stderr: "pipe" });
  expect(registry.stderr.toString()).toContain("Usage: vmem vaults add <id> <absolute-path>");
  expect(registry.stderr.toString()).toEndWith("Run 'vmem help vaults add' for details.\n");
  const noCommand = Bun.spawnSync([process.execPath, bin, "--color=invalid"], { env, stdout: "pipe", stderr: "pipe" });
  expect(noCommand.stderr.toString()).toEndWith("Usage: vmem <command> [args]\nRun 'vmem help' for details.\n");
});

test("evidence states use semantic markers and colors", () => {
  const report = { schemaVersion: 1 as const, vault: "v", note: { path: "notes/a.md", sha256: "abc" }, truncated: false as const, evidence: [{ index: 0, source: "notes/b.md", kind: "path" as const, expectedSha256: "abc", status: "verified" as const }] };
  expect(evidenceText(report, plain)).toContain("ok verified");
  const colored = evidenceText(report, color);
  expect(stripTerminal(colored)).toContain("ok verified");
  expect([...colored.matchAll(/\[([0-9;]+)m/g)].map(match => match[1])).toContain("1;32");
});
