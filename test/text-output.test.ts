import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paint, Report, resolveColor, ROLE_SGR, SGR_RESET } from "@staix/cli-output";
import { outputWidth, shellWord, takeColorFlag, textOptions, wrap } from "../src/text-output.ts";
import { run } from "../src/cli.ts";

test("#114 AC2: --color is taken once from anywhere before --, and auto follows the TTY, NO_COLOR and TERM", () => {
  expect(takeColorFlag(["status", "--color=never", "--json"])).toEqual({ args: ["status", "--json"], color: "never" });
  expect(takeColorFlag(["show", "v", "--", "--color=always"])).toEqual({ args: ["show", "v", "--", "--color=always"] });
  expect(() => takeColorFlag(["status", "--color"])).toThrow("--color=auto");
  expect(() => takeColorFlag(["status", "--color=never", "--color=always"])).toThrow("given once");
  expect(resolveColor("always", { isTTY: false }, "vmem")).toBe(true);
  expect(resolveColor("never", { isTTY: true }, "vmem")).toBe(false);
  expect(resolveColor(undefined, { isTTY: true }, "vmem")).toBe(true);
  expect(resolveColor("auto", { isTTY: true, NO_COLOR: "1" }, "vmem")).toBe(false);
  expect(resolveColor(undefined, { isTTY: true, TERM: "dumb" }, "vmem")).toBe(false);
  expect(resolveColor(undefined, { isTTY: false }, "vmem")).toBe(false);
  expect(resolveColor("sometimes", { isTTY: true }, "vmem")).toBeInstanceOf(Error);
  expect(textOptions("always", {}, { isTTY: false })).toEqual({ color: true, ascii: true });
  expect(outputWidth({ isTTY: true, columns: 60 })).toBe(60);
  expect(outputWidth({ isTTY: false, COLUMNS: "100" })).toBe(100);
  expect(outputWidth({ isTTY: false })).toBeUndefined();
  expect(() => run(["--version", "--color=sometimes"])).toThrow("--color=auto");
});

test("package report supplies table and field layout", () => {
  const out = new Report(40, true).header("vmem", "example").section("Fields").kv([["Vault", "personal"], ["Remote", ""]]).section("Rows").table(["Path", "Title"], [["notes/a.md", "Synthetic note"]]);
  const plain = out.render(false).join("\n");
  expect(plain).toContain("Vault:"); expect(plain).toContain("(unset)"); expect(plain).toContain("notes/a.md");
  expect(paint([{ text: "ok", role: "success" }], true)).toBe(ROLE_SGR.success + "ok" + SGR_RESET);
  expect(wrap("abcdefghijklmnop", 10)).toEqual(["abcdefghij", "klmnop"]);
  expect(shellWord("notes/a.md")).toBe("notes/a.md"); expect(shellWord("it's here")).toBe(`'it'"'"'s here'`);
});

test("#114 the executable dispatches on the command even when --color comes first", async () => {
  const bin = join(import.meta.dir, "..", "bin", "vmem.js"), home = mkdtempSync(join(tmpdir(), "vmem-color-"));
  try {
    const env = { ...process.env, VMEM_HOME: home, NO_COLOR: "" };
    const skills = Bun.spawnSync([process.execPath, bin, "--color=never", "skills", "mine", "absent"], { env, stdout: "pipe", stderr: "pipe" });
    expect(skills.stderr.toString()).not.toContain("unknown command");
    const bad = Bun.spawnSync([process.execPath, bin, "--color=loud", "status"], { env, stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("--color=auto");
    const mcp = Bun.spawn([process.execPath, bin, "--color=never", "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    mcp.stdin.end();
    const out = await new Response(mcp.stdout).text();
    expect(JSON.parse(out.trim().split("\n")[0]!).result.serverInfo.name).toBe("vmem");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
