import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, MAX_CONFIG_BYTES, parseConfig, readConfig } from "../src/config.ts";
import { resolveHome } from "../src/home.ts";
import { addVault, loadRegistry, removeVault } from "../src/registry.ts";
import { run } from "../src/cli.ts";
const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), "vmem-test-")); roots.push(dir); return dir; }
function fixture() {
  const dir = root(), home = join(dir, "state"), vault = join(dir, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "keep.md"), "# Keep\n");
  return { dir, home, vault, spec: { id: "personal", path: vault, kind: "personal" as const, write: "mcp" as const } };
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("configuration", () => {
  test("missing config is empty without creating home", () => {
    const home = join(root(), "absent");
    expect(readConfig(home)).toEqual({ vaults: [] });
    expect(existsSync(home)).toBe(false);
  });
  test("rejects unknown keys, invalid values, duplicate ids and malformed patterns", () => {
    const { spec } = fixture();
    for (const value of [null, [], {}, { vaults: [], typo: true }, { vaults: [{ ...spec, write: "human" }] }, { vaults: [{ ...spec, path: "relative" }] }, { vaults: [{ ...spec, id: "../x" }] }, { vaults: [spec, spec] }, { vaults: [], piiPatterns: ["["] }, { vaults: [], home: "/elsewhere" }]) expect(() => parseConfig(value)).toThrow();
  });
  test("rejects malformed, oversized, symlink and directory config files", () => {
    const home = root(), file = join(home, CONFIG_FILE);
    writeFileSync(file, "{"); expect(() => readConfig(home)).toThrow();
    writeFileSync(file, " ".repeat(MAX_CONFIG_BYTES + 1)); expect(() => readConfig(home)).toThrow();
    rmSync(file); symlinkSync("target", file); expect(() => readConfig(home)).toThrow();
    rmSync(file); mkdirSync(file); expect(() => readConfig(home)).toThrow();
  });
  test("home precedence and pointer isolation", () => {
    const hub = root(), fallback = join(hub, "vmem"), moved = join(hub, "moved"), own = join(hub, "own");
    mkdirSync(fallback);
    expect(resolveHome({ AGENTHUB_HOME: hub })).toEqual({ home: fallback, source: "default" });
    writeFileSync(join(fallback, CONFIG_FILE), JSON.stringify({ home: moved }));
    expect(resolveHome({ AGENTHUB_HOME: hub })).toEqual({ home: moved, source: "config" });
    expect(resolveHome({ AGENTHUB_HOME: hub, VMEM_HOME: own })).toEqual({ home: own, source: "VMEM_HOME" });
    expect(() => resolveHome({ VMEM_HOME: "relative" })).toThrow();
    mkdirSync(moved); writeFileSync(join(moved, CONFIG_FILE), JSON.stringify({ home: fallback }));
    expect(() => loadRegistry(moved)).toThrow("another home pointer");
  });
});
describe("registry", () => {
  test("agent add, preview and confirm preserve vault files and config policy", () => {
    const { home, vault, spec } = fixture();
    mkdirSync(home); writeFileSync(join(home, CONFIG_FILE), JSON.stringify({ vaults: [], denyPaths: ["private"], piiPatterns: ["sensitive"] }));
    const env = { VMEM_HOME: home, CLAUDECODE: "1", CODEX_THREAD_ID: "test" };
    const added = run(["vaults", "add", "personal", vault, "--kind", "personal", "--write", "mcp", "--json"], env);
    expect(JSON.parse(added.text).applied).toBe(true);
    const before = readFileSync(join(home, CONFIG_FILE), "utf8");
    expect(removeVault(home, "personal")).toEqual({ applied: false, vault: { ...spec, path: realpathSync(vault) } });
    expect(readFileSync(join(home, CONFIG_FILE), "utf8")).toBe(before);
    expect(removeVault(home, "personal", true).applied).toBe(true);
    expect(loadRegistry(home)).toEqual({ vaults: [], denyPaths: ["private"], piiPatterns: ["sensitive"] });
    expect(readFileSync(join(vault, "notes", "keep.md"), "utf8")).toBe("# Keep\n");
    expect(existsSync(join(home, "config.lock"))).toBe(false);
  });
  test("duplicate ids, canonical aliases and linked notes refuse", () => {
    const { home, vault, spec, dir } = fixture();
    addVault(home, spec);
    expect(() => addVault(home, spec)).toThrow("already registered");
    const alias = join(dir, "alias"); symlinkSync(vault, alias);
    expect(() => addVault(home, { ...spec, id: "other", path: alias })).toThrow("already registered");
    rmSync(join(vault, "notes"), { recursive: true });
    symlinkSync(dir, join(vault, "notes"));
    expect(() => addVault(home, { ...spec, id: "other" })).toThrow("symlink");
  });
  test("an offline registered vault does not block a separate registration", () => {
    const first = fixture(), second = fixture();
    addVault(first.home, first.spec);
    rmSync(first.vault, { recursive: true });
    expect(addVault(first.home, { ...second.spec, id: "second" }).id).toBe("second");
    expect(loadRegistry(first.home).vaults).toHaveLength(2);
  });
  test("temp creation and cleanup failures preserve the error and release the lock", () => {
    for (const mode of ["open", "cleanup"]) {
      const { home, vault } = fixture();
      const result = Bun.spawnSync([process.execPath, "test/fixtures/registry-fault.ts", home, vault, mode], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        message: mode === "open" ? "injected temp open failure" : "injected write failure",
        released: true, unchanged: true, recovered: true,
      });
    }
  });
  test("existing writer lock refuses without modifying config or lock", () => {
    const { home, spec } = fixture();
    mkdirSync(home); const lock = join(home, "config.lock"); writeFileSync(lock, "another writer");
    expect(() => addVault(home, spec)).toThrow();
    expect(readFileSync(lock, "utf8")).toBe("another writer");
    expect(existsSync(join(home, CONFIG_FILE))).toBe(false);
  });
  test("failed mutation leaves config intact and releases owned lock", () => {
    const { home, spec } = fixture(); addVault(home, spec);
    const before = readFileSync(join(home, CONFIG_FILE), "utf8");
    expect(() => removeVault(home, "unknown", true)).toThrow("unknown id");
    expect(readFileSync(join(home, CONFIG_FILE), "utf8")).toBe(before);
    expect(existsSync(join(home, "config.lock"))).toBe(false);
  });
});
describe("CLI", () => {
  test("help/version and closed argument parsing", () => {
    expect(run(["--help"]).text).toContain("vaults remove");
    expect(run(["--version"]).text).toBe("0.1.0");
    const env = { VMEM_HOME: join(root(), "home") };
    for (const args of [["missing"], ["status", "extra"], ["status", "--confirm"], ["status", "--json", "--json"], ["vaults", "add", "x", "/tmp", "--kind"]]) expect(() => run(args, env)).toThrow();
  });
  test("doctor detects unavailable vault; reads never create a registry", () => {
    const { home, vault, spec } = fixture();
    expect(run(["doctor"], { VMEM_HOME: home }).code).toBe(0);
    expect(existsSync(home)).toBe(false);
    addVault(home, spec); rmSync(vault, { recursive: true });
    expect(run(["doctor", "--json"], { VMEM_HOME: home }).code).toBe(1);
    expect(JSON.parse(run(["status", "--json"], { VMEM_HOME: home }).text).healthy).toBe(false);
  });
  test("bootstrap supports non-TTY agent invocation and refuses Node", () => {
    const env = { ...process.env, VMEM_HOME: join(root(), "home"), CLAUDECODE: "1" };
    const result = Bun.spawnSync([process.execPath, "bin/vmem.js", "status", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).stage).toBe("foundation");
    const node = Bun.spawnSync(["node", "bin/vmem.js", "--version"], { env, stdout: "pipe", stderr: "pipe" });
    expect(node.exitCode).toBe(1);
    expect(node.stderr.toString()).toContain("Bun >=1.4.2");
  });
});
