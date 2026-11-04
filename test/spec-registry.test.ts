import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, CONFIG_VERSION, parseConfig, parseSpec } from "../src/config.ts";
import { addSpec, removeSpec, specStatus, addVault, loadRegistry, LOCK_FILE, setVaultPii } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { completionDefinitions, completionScript } from "../src/commands-table.ts";
import { memoryGitArgv, memoryGitEnv } from "../src/platform.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-spec-registry-"))); roots.push(root);
  const home = join(root, "state");
  const git = (args: string[]) => {
    const result = Bun.spawnSync(memoryGitArgv(args), { env: memoryGitEnv(process.env, { repositoryIsolation: true }), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
  };
  const repo = (name: string, bare = false) => {
    const dir = join(root, name);
    git(["-c", "init.templateDir=", "init", "--quiet", ...(bare ? ["--bare"] : []), dir]);
    if (!bare) writeFileSync(join(dir, "SPEC.md"), "---\nid: synthetic-goal\ntype: goal\ntitle: A synthetic goal\n---\n# Goal\n");
    return dir;
  };
  return { root, home, repo, git, env: { VMEM_HOME: home }, config: () => readFileSync(join(home, CONFIG_FILE), "utf8") };
}
function tree(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name);
    return [entry.name, entry.isSymbolicLink() ? { link: readlinkSync(file) } : entry.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}

test("spec config uses separate defaults and strict fields, supports specs-only input and shared ids", () => {
  const f = fixture(), path = f.repo("repo");
  expect(CONFIG_VERSION).toBe(3);
  const entry = { id: "source", path, write: "none", pii: "deny" } as const;
  expect(parseSpec({ id: "source", path })).toEqual(entry);
  expect(parseConfig({ specs: [{ id: "source", path }] })).toEqual({ vaults: [], specs: [entry] });
  expect(parseConfig({ vaults: [] })).toEqual({ vaults: [] });
  for (const value of [null, [], { ...entry, typo: true }, { ...entry, id: "Bad" }, { ...entry, id: "a".repeat(33) }, { ...entry, path: "relative" }, { ...entry, write: "other" }, { ...entry, write: null }, { ...entry, pii: "warn" }, { ...entry, pii: null }, { ...entry, pii: {} }]) expect(() => parseSpec(value)).toThrow();
  expect(() => parseConfig({ vaults: [], specs: {} })).toThrow("config.specs");
  expect(() => parseConfig({ vaults: [], specs: [entry, entry] })).toThrow("duplicate source id");
  expect(() => parseConfig({ vaults: [], specs: [entry, { ...entry, id: "other" }] })).toThrow("duplicate spec source path");
  expect(() => parseConfig({ vaults: [{ id: "source", path, kind: "personal", write: "cli" }], specs: [entry] })).toThrow("duplicate source id");
  expect(() => parseConfig({ home: path, specs: [] })).toThrow("home pointer");
});

test("spec add canonicalizes a root without notes, defaults policies and shares the atomic registry", () => {
  const f = fixture(), repo = f.repo("repo with spaces "), alias = join(f.root, "alias"), before = tree(repo);
  symlinkSync(repo, alias);
  expect(addSpec(f.home, { id: "source", path: alias })).toEqual({ id: "source", path: repo, write: "none", pii: "deny" });
  expect(JSON.parse(f.config())).toEqual({ vaults: [], specs: [{ id: "source", path: repo, write: "none", pii: "deny" }], version: 2 });
  expect(loadRegistry(f.home).specs?.[0]?.path).toBe(repo);
  expect(existsSync(join(repo, "notes"))).toBe(false);
  expect(existsSync(join(f.home, LOCK_FILE))).toBe(false);
  const config = f.config();
  expect(() => addSpec(f.home, { id: "source", path: f.repo("other") })).toThrow("id already registered");
  expect(() => addSpec(f.home, { id: "alias", path: alias })).toThrow("path already registered");
  expect(f.config()).toBe(config);
  expect(tree(repo)).toEqual(before);
  expect(readdirSync(f.home)).toEqual([CONFIG_FILE]);
});

test("spec registration refuses missing, plain, nested and bare paths with a usable next step", () => {
  const f = fixture(), repo = f.repo("repo"), plain = join(f.root, "plain"), nested = join(repo, "nested");
  mkdirSync(plain); mkdirSync(nested);
  const before = tree(repo);
  for (const path of [join(f.root, "missing"), plain, nested, f.repo("bare", true)]) {
    expect(() => addSpec(f.home, { id: "source", path })).toThrow(/vmem specs|rev-parse/);
  }
  expect(existsSync(f.home)).toBe(false);
  expect(tree(repo)).toEqual(before);
});

test("vault and spec ids cannot collide in either registration direction", () => {
  const f = fixture(), repo = f.repo("repo"), vault = join(f.root, "vault"); mkdirSync(join(vault, "notes"), { recursive: true });
  addSpec(f.home, { id: "spec", path: repo });
  expect(() => addVault(f.home, { id: "spec", path: vault, kind: "personal", write: "cli" })).toThrow("id already registered");
  addVault(f.home, { id: "vault", path: vault, kind: "personal", write: "cli" });
  expect(() => addSpec(f.home, { id: "vault", path: f.repo("another") })).toThrow("id already registered");
  expect(loadRegistry(f.home).vaults.map(v => v.id)).toEqual(["vault"]);
  expect(loadRegistry(f.home).specs?.map(v => v.id)).toEqual(["spec"]);
});

test("spec removal previews without a lock and confirm only unregisters, preserving repository and policies", () => {
  const f = fixture(), repo = f.repo("repo");
  addSpec(f.home, { id: "source", path: repo, write: "mcp", pii: "allow" });
  const before = tree(repo), config = f.config(), lock = join(f.home, LOCK_FILE);
  writeFileSync(lock, "Synthetic existing writer lock.\n");
  expect(removeSpec(f.home, "source")).toMatchObject({ applied: false, spec: { write: "mcp", pii: "allow" } });
  expect(() => removeSpec(f.home, "source", true)).toThrow("registry is locked");
  expect(f.config()).toBe(config);
  expect(readFileSync(lock, "utf8")).toBe("Synthetic existing writer lock.\n");
  expect(() => addSpec(f.home, { id: "second", path: f.repo("second") })).toThrow("registry is locked");
  rmSync(lock);
  expect(removeSpec(f.home, "source", true).applied).toBe(true);
  expect(loadRegistry(f.home)).toMatchObject({ version: 2, specs: [] });
  expect(tree(repo)).toEqual(before);
  expect(() => removeSpec(f.home, "unknown")).toThrow("vmem specs list");
});

test("legacy vault-only config and output remain byte-identical, specs have their own output key", () => {
  const f = fixture(), repo = f.repo("repo"), vault = join(f.root, "vault"); mkdirSync(join(vault, "notes"), { recursive: true });
  addVault(f.home, { id: "personal", path: vault, kind: "personal", write: "cli" });
  const config = f.config(), before = run(["status", "--json"], f.env), doctor = run(["doctor", "--json"], f.env), list = run(["vaults", "list", "--json"], f.env);
  setVaultPii(f.home, "personal", "allow", true);
  expect(f.config()).toBe(config);
  expect(JSON.parse(config)).not.toHaveProperty("version");
  expect(run(["status", "--json"], f.env)).toEqual(before);
  expect(run(["doctor", "--json"], f.env)).toEqual(doctor);
  expect(run(["vaults", "list", "--json"], f.env)).toEqual(list);
  expect(JSON.parse(before.text)).not.toHaveProperty("specs");
  addSpec(f.home, { id: "source", path: repo });
  const status = JSON.parse(run(["status", "--json"], f.env).text), old = JSON.parse(before.text);
  expect(status.vaults).toEqual(old.vaults);
  expect(status.specs).toEqual(loadRegistry(f.home).specs);
  delete status.specs;
  expect(JSON.stringify(status)).toBe(before.text);
  expect(run(["vaults", "list", "--json"], f.env)).toEqual(list);
});

test("doctor isolates unhealthy spec roots and remains read-only; inherited git overrides cannot spoof roots", () => {
  const f = fixture(), one = f.repo("one"), two = f.repo("two");
  addSpec(f.home, { id: "one", path: one }); addSpec(f.home, { id: "two", path: two, write: "cli" });
  const hostileEnv = { ...process.env, ...f.env, GIT_DIR: join(one, ".git"), GIT_WORK_TREE: one, GIT_INDEX_FILE: join(f.root, "foreign-index") };
  expect(specStatus(f.home, hostileEnv).every(source => source.healthy)).toBe(true);
  renameSync(join(two, ".git"), join(two, "old-git"));
  const before = tree(f.root), out = run(["doctor", "--json"], hostileEnv);
  expect(out.code).toBe(1);
  const result = JSON.parse(out.text);
  expect(result.healthy).toBe(false);
  expect(result.specs[0]).toMatchObject({ id: "one", healthy: true });
  expect(result.specs[1]).toMatchObject({ id: "two", healthy: false, issue: expect.stringContaining("vmem specs remove") });
  expect(tree(f.root)).toEqual(before);
});

test("doctor flags unavailable and symlink-rebound source roots without suppressing the registry", () => {
  const f = fixture(), repo = f.repo("repo"), moved = join(f.root, "moved");
  addSpec(f.home, { id: "source", path: repo });
  renameSync(repo, moved);
  expect(run(["doctor", "--json"], f.env).code).toBe(1);
  symlinkSync(moved, repo);
  const before = tree(f.root);
  expect(specStatus(f.home)[0]).toMatchObject({ healthy: false });
  expect(JSON.parse(run(["specs", "list", "--json"], f.env).text)[0].path).toBe(repo);
  expect(tree(f.root)).toEqual(before);
});

test("future-format fields survive shared registry writes and its version is never downgraded", () => {
  const f = fixture(), repo = f.repo("repo"); mkdirSync(f.home);
  writeFileSync(join(f.home, CONFIG_FILE), JSON.stringify({ version: CONFIG_VERSION + 1, vaults: [], specs: [{ id: "first", path: repo, futureSource: { marker: true } }], futureConfig: true }));
  addSpec(f.home, { id: "second", path: f.repo("second") });
  removeSpec(f.home, "second", true);
  expect(JSON.parse(f.config())).toMatchObject({ version: CONFIG_VERSION + 1, futureConfig: true, specs: [{ futureSource: { marker: true }, write: "none", pii: "deny" }] });
});

test("spec CLI uses the command table, rejects unknown flags and stays read-only when listing/previewing", () => {
  const f = fixture(), repo = f.repo("repo");
  expect(run(["specs", "list", "--json"], f.env)).toEqual({ code: 0, text: "[]" });
  expect(existsSync(f.home)).toBe(false);
  expect(run(["specs", "add", "source", repo, "--write", "cli", "--pii", "allow", "--json"], f.env).code).toBe(0);
  expect(JSON.parse(run(["specs", "list", "--json"], f.env).text)).toEqual([{ id: "source", path: repo, write: "cli", pii: "allow" }]);
  const before = tree(f.root);
  expect(JSON.parse(run(["specs", "remove", "source", "--json"], f.env).text).applied).toBe(false);
  expect(tree(f.root)).toEqual(before);
  expect(() => run(["specs", "add", "source", repo, "--kind", "personal"], f.env)).toThrow("unknown or repeated option");
  expect(() => run(["specs", "list", "--confirm"], f.env)).toThrow("unknown or repeated option");
  expect(() => run(["specs", "remove"], f.env)).toThrow("vmem specs list");
  expect(run(["specs", "remove", "source", "--confirm"], f.env).code).toBe(0);
  expect(JSON.parse(run(["specs", "list", "--json"], f.env).text)).toEqual([]);
  const definitions = completionDefinitions();
  expect(definitions.find(item => item.path.join(" ") === "specs add")?.options["--write"]).toEqual({ value: ["mcp", "cli", "none"] });
  for (const shell of ["bash", "zsh", "fish"]) expect(completionScript(shell)).toContain("specs");
  const syntax = Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(completionScript("bash")), stdout: "pipe", stderr: "pipe" });
  expect(syntax.exitCode).toBe(0);
});

test("spec roots containing a backslash register and remain healthy", () => {
  const f = fixture(), repo = f.repo("repo\\with-backslash");
  expect(addSpec(f.home, { id: "backslash", path: repo }).path).toBe(repo);
  expect(specStatus(f.home)[0]).toMatchObject({ id: "backslash", healthy: true });
  const result = run(["doctor", "--json"], f.env);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.text).specs[0].healthy).toBe(true);
});

test("spec root failures distinguish missing git, non-root paths and git refusals", () => {
  const f = fixture(), repo = f.repo("repo"), nested = join(repo, "nested"), plain = join(f.root, "plain");
  mkdirSync(nested); mkdirSync(plain);
  const noGit = { ...f.env, PATH: join(f.root, "no-git") };
  expect(() => addSpec(f.home, { id: "missing-git", path: repo }, noGit)).toThrow("git could not run (ENOENT); install git or fix PATH");
  expect(() => addSpec(f.home, { id: "nested", path: nested })).toThrow(`not its root; register the reported root ${repo}`);
  expect(() => addSpec(f.home, { id: "plain", path: plain })).toThrow("git refused the root check");
  addSpec(f.home, { id: "source", path: repo });
  const missing = run(["doctor", "--json"], noGit);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.text).specs[0].issue).toContain("install git or fix PATH");
  const file = join(f.home, CONFIG_FILE), config = JSON.parse(f.config());
  config.specs[0].path = nested; writeFileSync(file, JSON.stringify(config));
  expect(specStatus(f.home)[0]).toMatchObject({ issue: expect.stringContaining(`reported root ${repo}`) });
  config.specs[0].path = plain; writeFileSync(file, JSON.stringify(config));
  expect(specStatus(f.home)[0]).toMatchObject({ issue: expect.stringContaining("not a git repository") });
});

test("spec root timeout and output-limit diagnostics retain the applicable next step", () => {
  const f = fixture(), repo = f.repo("repo");
  for (const code of ["ETIMEDOUT", "ENOBUFS"]) {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { mock } from "bun:test";
      const child = await import("node:child_process");
      mock.module("node:child_process", () => ({ ...child, spawnSync: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("synthetic failure"), { code: ${JSON.stringify(code)} }) }) }));
      const { addSpec } = await import("./src/registry.ts");
      try { addSpec(${JSON.stringify(f.home)}, { id: "source", path: ${JSON.stringify(repo)} }); process.exit(2); }
      catch (error) { process.stdout.write(error.message); }
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain(code === "ETIMEDOUT" ? "timed out after 5000 ms; retry" : "output exceeded 64 KiB; inspect git");
  }
});
