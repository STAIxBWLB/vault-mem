import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync, readdirSync, readlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, MAX_CONFIG_BYTES, parseConfig, readConfig } from "../src/config.ts";
import { resolveHome } from "../src/home.ts";
import { addVault, loadRegistry, recoverRegistry, removeVault, syncDirectory } from "../src/registry.ts";
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
  test("a directory fsync failure after the rename reports a committed update and releases the lock", () => {
    const { home, vault } = fixture();
    const result = Bun.spawnSync([process.execPath, "test/fixtures/registry-fault.ts", home, vault, "fsync"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout.toString()) as { message: string; released: boolean; ids: string[] };
    expect(out.message).toBe(`${join(home, CONFIG_FILE)}: registry updated but directory fsync failed: injected directory fsync failure`);
    expect(out.released).toBe(true);
    expect(out.ids).toEqual(["personal"]);
  });
  test("inaccessible or looping registered paths do not block distinct healthy vaults", () => {
    for (const mode of ["EACCES", "ELOOP"]) {
      const { home, vault } = fixture();
      const result = Bun.spawnSync([process.execPath, "test/fixtures/registry-fault.ts", home, vault, mode], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ added: "personal", duplicateRefused: true, unhealthy: true });
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
    expect(() => removeVault(home, "unknown", true)).toThrow("unknown vault id");
    expect(readFileSync(join(home, CONFIG_FILE), "utf8")).toBe(before);
    expect(existsSync(join(home, "config.lock"))).toBe(false);
  });
});
describe("CLI", () => {
  test("help/version and closed argument parsing", () => {
    expect(run(["--help"]).text).toContain("vaults remove");
    expect(run(["--version"]).text).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
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
describe("follow-ups", () => {
  const lockOf = (home: string) => join(home, "config.lock");
  test("recover removes a dead same-host lock and leftover temp files only on confirm", () => {
    const { home, spec } = fixture(); addVault(home, spec);
    const before = readFileSync(join(home, CONFIG_FILE), "utf8");
    const dead = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"], { stdout: "pipe" });
    const pid = Number(dead.stdout.toString().trim());
    writeFileSync(lockOf(home), JSON.stringify({ pid, host: hostname(), created: "2026-01-01T00:00:00.000Z" }));
    const temp = ".config-00000000-0000-4000-8000-000000000000.tmp";
    writeFileSync(join(home, temp), "partial");
    writeFileSync(join(home, "unrelated.tmp"), "keep");
    const preview = recoverRegistry(home);
    expect(preview).toMatchObject({ applied: false, lock: { state: "stale", removed: false }, temporaryFiles: [temp] });
    expect(existsSync(lockOf(home))).toBe(true);
    expect(() => addVault(home, { ...spec, id: "x" })).toThrow("vmem recover");
    const done = recoverRegistry(home, true);
    expect(done).toMatchObject({ applied: true, lock: { removed: true }, removedTemporaryFiles: [temp] });
    expect(existsSync(lockOf(home)) || existsSync(join(home, temp))).toBe(false);
    expect(readFileSync(join(home, "unrelated.tmp"), "utf8")).toBe("keep");
    expect(readFileSync(join(home, CONFIG_FILE), "utf8")).toBe(before);
  });
  test("recover never removes a live, foreign-host or unreadable lock", () => {
    for (const content of [JSON.stringify({ pid: process.pid, host: hostname(), created: "x" }), JSON.stringify({ pid: 1, host: "other-host.invalid", created: "x" }), "legacy"]) {
      const { home } = fixture(); mkdirSync(home);
      const temp = join(home, ".config-00000000-0000-4000-8000-000000000001.tmp");
      writeFileSync(lockOf(home), content); writeFileSync(temp, "partial");
      const report = recoverRegistry(home, true);
      expect(report.applied).toBe(false);
      expect(report.blocked).toBeTruthy();
      expect(readFileSync(lockOf(home), "utf8")).toBe(content);
      expect(existsSync(temp)).toBe(true);
      expect(run(["recover", "--confirm"], { VMEM_HOME: home }).code).toBe(1);
    }
  });
  test("an oversized lock file is unknown and never removed", () => {
    const { home } = fixture(); mkdirSync(home);
    const dead = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"], { stdout: "pipe" });
    const pid = Number(dead.stdout.toString().trim());
    const content = JSON.stringify({ pid, host: hostname(), created: "x", pad: "x".repeat(5000) });
    writeFileSync(lockOf(home), content);
    const report = recoverRegistry(home, true);
    expect(report).toMatchObject({ applied: false, lock: { state: "unknown", removed: false } });
    expect(readFileSync(lockOf(home), "utf8")).toBe(content);
    expect(run(["recover", "--confirm"], { VMEM_HOME: home }).code).toBe(1);
    expect(readFileSync(lockOf(home), "utf8")).toBe(content);
  });
  test("recover on a missing home reports nothing and creates nothing", () => {
    const home = join(root(), "absent");
    expect(run(["recover", "--json"], { VMEM_HOME: home }).code).toBe(0);
    expect(existsSync(home)).toBe(false);
  });
  test("written lock records owner; directory fsync works on this platform", () => {
    const { dir } = fixture();
    expect(syncDirectory(dir)).toBe(process.platform !== "win32");
    expect(syncDirectory(dir, "win32")).toBe(false);
  });
  test("serialized config overflow refuses without changing config", () => {
    const { home, vault, spec } = fixture(); mkdirSync(home);
    // Compact on-disk JSON just under 64 KiB; the pretty-printed rewrite exceeds the limit.
    const vaults: unknown[] = [];
    let compact = "";
    for (let i = 0; JSON.stringify({ vaults }).length < MAX_CONFIG_BYTES - 400; i++) {
      vaults.push({ id: `v${i}`, path: `/offline/${"x".repeat(80)}/${i}`, kind: "personal", write: "none" });
      compact = JSON.stringify({ vaults });
    }
    writeFileSync(join(home, CONFIG_FILE), compact);
    expect(loadRegistry(home).vaults.length).toBe(vaults.length);
    const before = readFileSync(join(home, CONFIG_FILE), "utf8");
    expect(() => addVault(home, spec)).toThrow("exceeds 64 KiB");
    expect(readFileSync(join(home, CONFIG_FILE), "utf8")).toBe(before);
    expect(existsSync(lockOf(home))).toBe(false);
  });
  test("vaults list and optional flags round-trip with effective pii", () => {
    const { home, vault } = fixture();
    const registry = join(root(), "reg");
    const added = JSON.parse(run(["vaults", "add", "org", vault, "--kind", "org", "--write", "none", "--pii", "allow", "--remote", "git@example.com:o/v.git", "--registry", registry, "--json"], { VMEM_HOME: home }).text);
    expect(added.vault).toMatchObject({ pii: "allow", remote: "git@example.com:o/v.git", registry });
    expect(JSON.parse(run(["vaults", "list", "--json"], { VMEM_HOME: home }).text)).toEqual([{ id: "org", path: realpathSync(vault), kind: "org", write: "none", pii: "allow", remote: "git@example.com:o/v.git", registry, piiPolicy: { ...Object.fromEntries(["email", "phone", "custom"].map(c => [c, { notes: "allow", log: "allow", promotion: "allow" }])), patterns: [], allow: [] } }]);
    const other = fixture();
    run(["vaults", "add", "team", other.vault, "--kind", "org", "--write", "cli"], { VMEM_HOME: home });
    expect(JSON.parse(run(["vaults", "list"], { VMEM_HOME: home }).text)[1].pii).toBe("deny");
    expect(() => run(["vaults", "add", "bad", other.vault, "--kind", "org", "--write", "cli", "--registry", "relative"], { VMEM_HOME: home })).toThrow("absolute");
    expect(() => run(["vaults", "list", "extra"], { VMEM_HOME: home })).toThrow();
    rmSync(other.vault, { recursive: true });
    const status = JSON.parse(run(["status", "--json"], { VMEM_HOME: home }).text);
    expect(status.vaults[1]).toMatchObject({ healthy: false, pii: "deny" });
  });
  test("doctor detects notes directory replaced by a symlink", () => {
    const { home, vault, spec, dir } = fixture(); addVault(home, spec);
    const moved = join(dir, "moved-notes");
    renameSync(join(vault, "notes"), moved); symlinkSync(moved, join(vault, "notes"));
    expect(run(["doctor"], { VMEM_HOME: home }).code).toBe(1);
    expect(readFileSync(join(moved, "keep.md"), "utf8")).toBe("# Keep\n");
  });
  test("errors carry config context without echoing content", () => {
    const home = root(), file = join(home, CONFIG_FILE);
    writeFileSync(file, "{\"vaults\": [SECRET-NOTE-TEXT");
    expect(() => readConfig(home)).toThrow(`${file}: invalid JSON`);
    try { readConfig(home); } catch (error) { expect((error as Error).message).not.toContain("SECRET"); }
    writeFileSync(file, JSON.stringify({ vaults: [], secretKey: 1 }));
    expect(() => readConfig(home)).toThrow(`${file}: config: unknown key`);
    expect(() => removeVault(join(root(), "h"), "nope")).toThrow("unknown vault id nope");
  });
  test("home paths are normalized", () => {
    const hub = root();
    expect(resolveHome({ VMEM_HOME: `${hub}/a/../b/` }).home).toBe(join(hub, "b"));
    expect(resolveHome({ AGENTHUB_HOME: `${hub}/./x/..` }).home).toBe(join(hub, "vmem"));
  });
  test("boundary check rejects forbidden imports in negative fixtures", () => {
    const pin = JSON.stringify({ dependencies: { "@staix/agent-mem": "0.17.0" } });
    const cases: [string, Record<string, string>, string, string?][] = [
      ["third-party", { "src/a.ts": "import x from \"left-pad\";" }, "forbidden dependency left-pad"],
      ["platform outside seam", { "src/a.ts": "import \"@staix/agent-mem/platform\";" }, "forbidden dependency @staix/agent-mem/platform"],
      ["root outside seam", { "src/platform.ts": "export * from \"@staix/agent-mem\";" }, "forbidden dependency @staix/agent-mem"],
      ["dynamic nonliteral", { "src/a.ts": "const m = \"x\"; await import(m);" }, "nonliteral import"],
      ["require", { "src/a.ts": "require(\"fs-extra\");" }, "forbidden dependency fs-extra"],
      ["dependency drift", { "src/a.ts": "" }, "exactly @staix/agent-mem 0.17.0", JSON.stringify({ dependencies: { "@staix/agent-mem": "^0.17.0" } })],
      ["allowed", { "src/platform.ts": "export * from \"@staix/agent-mem/platform\";", "src/amem/seam.ts": "export * from \"@staix/agent-mem\"; import \"node:fs\"; import \"./x.ts\";" }, "boundary: ok"],
    ];
    for (const [, files, expected, pkg] of cases) {
      const dir = root();
      writeFileSync(join(dir, "package.json"), pkg ?? pin);
      for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), text); }
      const result = Bun.spawnSync([process.execPath, "scripts/check-boundary.ts", dir], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(expected === "boundary: ok" ? 0 : 1);
      expect(result.stdout.toString() + result.stderr.toString()).toContain(expected);
    }
  });
});

// Synthetic migration fixtures; doctor must preserve both the vault and vmem home.
function migrationTree(dir: string): unknown {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isSymbolicLink() ? { symlink: readlinkSync(join(dir, entry.name)) } : entry.isDirectory() ? migrationTree(join(dir, entry.name)) : readFileSync(join(dir, entry.name)).toString("base64")]);
}
const migrationMoc = "---\ntype: moc\ndescription: A synthetic research directory.\n---\n# Research\n";
const migrationNote = '---\ndescription: Evidence supporting a synthetic claim.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# Claim\n\n## Topics\n- [[research]]\n';
test("writer refuses introduced V05 and preserves retained V05 warnings", () => {
  const f = fixture();
  writeFileSync(join(f.vault, "notes/research.md"), migrationMoc);
  const file = join(f.vault, "notes/keep.md");
  addVault(f.home, f.spec);
  const env = { VMEM_HOME: f.home };
  const patch = () => run(["patch", "personal", "keep", "--old", "- [[research]]", "--new", "- [[research]]\n## X\n", "--json"], env);
  writeFileSync(file, migrationNote);
  const before = migrationTree(f.dir), refused = patch();
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.text)).toMatchObject({ applied: false, issues: expect.arrayContaining([expect.objectContaining({ code: "V05", severity: "error" })]) });
  expect(migrationTree(f.dir)).toEqual(before);
  const frontmatter = run(["frontmatter", "personal", "keep", "--set", JSON.stringify({ topics: ["[[research]]", "[[research]]"] }), "--json"], env);
  expect(frontmatter.code).toBe(1);
  expect(JSON.parse(frontmatter.text).issues).toContainEqual(expect.objectContaining({ code: "V05", severity: "error" }));
  expect(migrationTree(f.dir)).toEqual(before);
  writeFileSync(file, migrationNote + "\n## Existing\n");
  const retained = patch();
  expect(retained.code).toBe(0);
  expect(JSON.parse(retained.text)).toMatchObject({ applied: true, issues: expect.arrayContaining([expect.objectContaining({ code: "V05", severity: "warning" })]) });
  expect(readFileSync(file, "utf8")).toContain("## X");
});

test("doctor reports pending tidy counts and unparsable paths without writing", () => {
  const f = fixture();
  writeFileSync(join(f.vault, "notes/research.md"), migrationMoc);
  writeFileSync(join(f.vault, "notes/keep.md"), migrationNote.replace('type: insight', 'type: insight\nconfidence: confirmed').replace("## Topics\n- [[research]]\n", "## Connections (legacy)\n"));
  writeFileSync(join(f.vault, "notes/broken.md"), "---\ntopics: [\n---\n# Broken\n");
  addVault(f.home, f.spec);
  const before = migrationTree(f.dir);
  const result = run(["doctor", "--json"], { VMEM_HOME: f.home });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.text).vaults[0].tidy).toMatchObject({ pending: { connections: 1, enums: 1, topics: 1 }, notes: 1, skipped: [], unparsable: ["notes/broken.md"], hint: expect.stringContaining("vmem tidy personal --all") });
  expect(migrationTree(f.dir)).toEqual(before);
  writeFileSync(join(f.vault, "notes/keep.md"), migrationNote);
  rmSync(join(f.vault, "notes/broken.md"));
  const cleanBefore = migrationTree(f.dir);
  expect(JSON.parse(run(["doctor", "--json"], { VMEM_HOME: f.home }).text).vaults[0]).not.toHaveProperty("tidy");
  expect(migrationTree(f.dir)).toEqual(cleanBefore);
});

test("doctor omits tidy for read-only vaults and unenforceable PII policies", () => {
  for (const write of ["none", "mcp"] as const) {
    const f = fixture();
    addVault(f.home, { ...f.spec, write });
    if (write === "mcp") {
      const file = join(f.home, CONFIG_FILE), config = JSON.parse(readFileSync(file, "utf8"));
      config.version = 2; config.vaults[0].pii = { default: "deny", future: true };
      writeFileSync(file, JSON.stringify(config));
    }
    const before = migrationTree(f.dir), result = run(["doctor", "--json"], { VMEM_HOME: f.home });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.text).vaults[0]).not.toHaveProperty("tidy");
    expect(migrationTree(f.dir)).toEqual(before);
  }
});

test("doctor isolates a second vault's symlinked log and preserves every file", () => {
  const f = fixture(), second = join(f.dir, "second"), logTarget = join(f.dir, "log-target");
  writeFileSync(join(f.vault, "notes/research.md"), migrationMoc);
  writeFileSync(join(f.vault, "notes/keep.md"), migrationNote.replace("## Topics\n- [[research]]\n", ""));
  mkdirSync(join(second, "notes"), { recursive: true });
  writeFileSync(join(second, "notes/research.md"), migrationMoc);
  writeFileSync(logTarget, "Synthetic log target, unchanged.\n");
  symlinkSync(logTarget, join(second, "log"));
  addVault(f.home, f.spec);
  addVault(f.home, { ...f.spec, id: "second", path: second });
  const before = migrationTree(f.dir), result = run(["doctor", "--json"], { VMEM_HOME: f.home });
  expect(result.code).toBe(1);
  const report = JSON.parse(result.text);
  expect(report.healthy).toBe(false);
  expect(report.vaults).toHaveLength(2);
  expect(report.vaults[0]).toMatchObject({ id: "personal", healthy: true, tidy: { pending: { topics: 1 }, notes: 1 } });
  expect(typeof report.vaults[1].checks.tidy.issue).toBe("string");
  expect(report.vaults[1].checks.tidy.issue.length).toBeGreaterThan(0);
  expect(report.vaults[1]).toMatchObject({ id: "second", checks: { tidy: { ok: false } } });
  expect(report.vaults[1]).not.toHaveProperty("tidy");
  expect(migrationTree(f.dir)).toEqual(before);
});
