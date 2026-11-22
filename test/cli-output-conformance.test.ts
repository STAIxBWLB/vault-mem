import { expect, test } from "bun:test";
import { errorLine, paint, markerCell, resolveColor, ROLE_SGR, SGR_RESET, type Role } from "@staix/cli-output";
import { stripTerminal, table, textOptions, width } from "../src/text-output.ts";
import { run } from "../src/cli.ts";
import { evidenceText } from "../src/read-output.ts";
import { renderStatus } from "../src/cli-output.ts";

const plain = { color: false, ascii: true };
const color = { color: true, ascii: true };
test("shared roles and markers render a report with and without color", () => {
  const report = (o: typeof plain) => [paint([{ text: "vmem report", role: "header" }], o.color), `${paint([{ text: markerCell("ok", o.ascii), role: "success" }], o.color)} healthy`, `${paint([{ text: markerCell("fail", o.ascii), role: "error" }], o.color)} failed`].join("\n");
  expect(report(plain)).toBe("vmem report\nok healthy\nx  failed");
  expect(stripTerminal(report(color))).toBe(report(plain));
  expect(report(color)).toBe([paint([{ text: "vmem report", role: "header" }], color.color), `${paint([{ text: "ok", role: "success" }], color.color)} healthy`, `${paint([{ text: "x ", role: "error" }], color.color)} failed`].join("\n"));
  const roles = Object.keys(ROLE_SGR) as Role[];
  for (const role of roles) expect(paint([{ text: "sample", role }], color.color)).toBe(ROLE_SGR[role] ? `${ROLE_SGR[role]}sample${SGR_RESET}` : "sample");
});
test("status report is golden with color off and on", () => {
  const report = { home: "/synthetic", source: "VMEM_HOME" as const, version: "9.0.0", healthy: true, vaults: [] };
  const expected = [" vmem status", "", "> Home", "  Version:    9.0.0", "  Home:       /synthetic", "  Source:     VMEM_HOME", "  Health:     healthy", "  agent-mem:  (unset)", "  Host API:   (unset)", "", "> Vaults", "  no vaults registered", "    -> vmem help vaults add", "", "> Spec sources", "  no spec sources registered", "    -> vmem help specs add"].join("\n");
  expect(renderStatus(report, plain)).toBe(expected);
  const colored = renderStatus(report, color);
  expect(stripTerminal(colored)).toBe(expected);
  expect(colored).not.toBe(expected);
});
test("color precedence and JSON on pipes", () => {
  const env = { isTTY: false, TERM: "dumb", FORCE_COLOR: "1" };
  expect(resolveColor("auto", env, "vmem")).toBe(true);
  expect(resolveColor("auto", { ...env, NO_COLOR: "1" }, "vmem")).toBe(false);
  expect(resolveColor("always", { ...env, NO_COLOR: "1" }, "vmem")).toBe(true);
  expect(resolveColor("never", env, "vmem")).toBe(false);
  expect(resolveColor("auto", { isTTY: true, FORCE_COLOR: "0" }, "vmem")).toBe(false);
  expect(resolveColor("auto", { isTTY: false, CLICOLOR_FORCE: "1", CLICOLOR: "0" }, "vmem")).toBe(true);
  expect(resolveColor("auto", { isTTY: true, CLICOLOR: "0" }, "vmem")).toBe(false);
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
  expect(markerCell("ok", options.ascii === true)).toBe("ok");
  expect(markerCell("fail", options.ascii === true)).toBe("x ");
  expect(markerCell("next", options.ascii === true)).toBe("->");
  expect(markerCell("ok", textOptions("never", { LANG: "C.UTF-8" }).ascii === true)).toBe("✓ ");
});
test("stderr decides color independently of stdout", () => {
  const env = { LANG: "C.UTF-8", TERM: "xterm" };
  const stdout = textOptions("auto", env, { isTTY: false });
  const stderr = textOptions("auto", env, { isTTY: true });
  expect(stdout.color).toBe(false);
  expect(stderr.color).toBe(true);
  expect(errorLine("vmem", "failed", "", { tty: true, ascii: stderr.ascii })[0]).toBe("✗ vmem: failed");
  expect(errorLine("vmem", "failed", "", { tty: false, ascii: stdout.ascii })[0]).toBe("vmem: failed");
  const forced = textOptions("auto", { ...env, FORCE_COLOR: "1" }, { isTTY: false });
  expect(paint([{ text: errorLine("vmem", "failed", "", { tty: false, ascii: forced.ascii })[0]!, role: "error" }], forced.color)).not.toBe(errorLine("vmem", "failed", "", { tty: false, ascii: stdout.ascii })[0]);
  expect(stripTerminal(paint([{ text: errorLine("vmem", "failed", "", { tty: false, ascii: forced.ascii })[0]!, role: "error" }], forced.color))).toBe("vmem: failed");
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
  expect(multi.stderr.toString().split("\n").slice(-4)).toEqual([
    "Usage: vmem graph path <vault> <from> <to> [--max-hops 1..6] [--relation REL]",
    "    [--via-hubs] [--json]",
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
