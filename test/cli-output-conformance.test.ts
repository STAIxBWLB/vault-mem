import { expect, test } from "bun:test";
import { paint, marker, resolveColor, stripTerminal, table, textOptions, width } from "../src/text-output.ts";
import { run } from "../src/cli.ts";

const plain = { color: false, ascii: true };
const color = { color: true, ascii: true };
test("shared roles and markers render a report with and without color", () => {
  const report = (o: typeof plain) => [paint("vmem report", "header", o), `${marker("ok", o)} healthy`, `${marker("fail", o)} failed`].join("\n");
  expect(report(plain)).toBe("vmem report\nok healthy\nx  failed");
  expect(stripTerminal(report(color))).toBe(report(plain));
  expect(report(color)).toBe([paint("vmem report", "header", color), `${paint("ok", "success", color)} healthy`, `${paint("x ", "error", color)} failed`].join("\n"));
  expect(new Set(["header", "section", "key", "success", "warning", "error", "hint", "accent"].map(role => paint("x", role as "header", color))).size).toBe(8);
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

test("usage and operation failures have distinct process exits", () => {
  const bin = new URL("../bin/vmem.js", import.meta.url).pathname;
  const env = { ...process.env, LANG: "C", VMEM_HOME: "/nonexistent-vmem-test-home" };
  for (const args of [["lint"], ["check"], ["not-a-command"], ["lint", "--bad"]]) {
    const result = Bun.spawnSync([process.execPath, bin, ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("vmem: ");
  }
  const failure = Bun.spawnSync([process.execPath, bin, "lint", "missing"], { env, stdout: "pipe", stderr: "pipe" });
  expect(failure.exitCode).toBe(1);
  expect(failure.stderr.toString()).toContain("vmem: ");
});
