import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, loadRegistry, removeVault } from "../src/registry.ts";
import { CONFIG_FILE, CONFIG_VERSION } from "../src/config.ts";
import { VaultIndex, LINK_RESOLUTION } from "../src/vault-index.ts";
import { VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";
import { COMMANDS } from "../src/commands-table.ts";
import { runSetup } from "../src/setup.ts";
import { run } from "../src/cli.ts";

// Staged upgrades (#82): versions of vmem coexist on one machine. Every fixture lives in a temp dir.
const REPO = realpathSync(join(import.meta.dir, ".."));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\n---\n# ${title}\n\nSee [[beta]].\n\n## Topics\n\n- [[research]]\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-coexist-"))); roots.push(root);
  const home = join(root, "state");
  const make = (name: string) => {
    const notes = join(root, name, "notes"); mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
    if (name === "mine") { writeFileSync(join(notes, "alpha.md"), note("Alpha")); writeFileSync(join(notes, "beta.md"), note("Beta")); }
    return join(root, name);
  };
  addVault(home, { id: "mine", path: make("mine"), kind: "personal", write: "mcp" });
  addVault(home, { id: "team", path: make("team"), kind: "org", write: "mcp" });
  return { root, home };
}
/** A release root `<root>/releases/<version>/` as a versioned install lays it out, sharing this checkout's node_modules. */
function release(root: string, version: string): string {
  const dir = join(root, "releases", version); mkdirSync(dir, { recursive: true });
  for (const part of ["src", "bin"]) cpSync(join(REPO, part), join(dir, part), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")), version }));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  return dir;
}
function server(dir: string, env: Record<string, string>) {
  const { AGENTHUB_HOME: _, ...inherited } = process.env;
  const proc = Bun.spawn([process.execPath, join(dir, "bin", "vmem.js"), "mcp"], { env: { ...inherited, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader(), decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<any> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); return JSON.parse(line); }
      const { value, done } = await reader.read();
      if (done) throw new Error(`server closed: ${await new Response(proc.stderr).text()}`);
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const send = (frame: object) => { proc.stdin.write(JSON.stringify(frame) + "\n"); proc.stdin.flush(); };
  const init = async () => {
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const response = await next();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response.result.serverInfo.version as string;
  };
  return { proc, next, send, init };
}
const payload = (response: any) => JSON.parse(response.result.content[0].text);

test("AC1: a running server keeps its own code and tool list after its install is replaced; a new session gets the new release", async () => {
  const f = fixture(), sandbox = join(f.root, "sandbox"); mkdirSync(sandbox);
  const env = { VMEM_HOME: f.home, HOME: sandbox, AMEM_HOME: join(f.root, "no-amem"), CLAUDECODE: "1" };
  const older = release(f.root, "9.9.1"), newer = release(f.root, "9.9.2");
  const running = server(older, env);
  try {
    expect(await running.init()).toBe("9.9.1");
    // An in-place upgrade or removal of the release: nothing the handlers import is on disk any more.
    rmSync(join(older, "src"), { recursive: true, force: true });
    running.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    running.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vmem_skills_mine", arguments: { vault: "mine" } } });
    running.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vmem_promote", arguments: { path: "alpha", to: "team" } } });
    const [list, mine, promote] = [await running.next(), await running.next(), await running.next()];
    expect(list.result.tools.map((t: any) => t.name)).toEqual([...VMEM_TOOL_NAMES]);
    expect(payload(mine).refused).toBeUndefined();
    expect(payload(mine)).toHaveProperty("candidates");
    expect(payload(promote)).toMatchObject({ ok: true, applied: false });
  } finally { running.proc.kill(); await running.proc.exited; }
  const fresh = server(newer, env);
  try { expect(await fresh.init()).toBe("9.9.2"); } finally { fresh.proc.kill(); await fresh.proc.exited; }
}, 30_000);

test("AC2: a config written by a newer version is read without error, and its unknown keys survive this version's write", () => {
  const f = fixture(), file = join(f.home, CONFIG_FILE);
  // This version never adds `version`, so 0.2.4 and older keep reading its config.
  expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("version");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const future = { ...raw, version: CONFIG_VERSION + 1, futureTop: { nested: [1, 2] },
    vaults: raw.vaults.map((v: any, i: number) => i ? v : { ...v, futureVault: "x", pii: { email: { notes: "deny", futureSurface: "allow" }, futurePii: true, patterns: [{ name: "badge", regex: "B-\\d+", futurePattern: 1 }] } }) };
  writeFileSync(file, JSON.stringify(future));
  expect(loadRegistry(f.home).vaults.map(v => v.id)).toEqual(["mine", "team"]);
  removeVault(f.home, "team", true); // this version's write
  const written = JSON.parse(readFileSync(file, "utf8"));
  expect(written).toMatchObject({ version: CONFIG_VERSION + 1, futureTop: { nested: [1, 2] } });
  expect(written.vaults).toEqual([future.vaults[0]]);
  // At or below this version an unknown key is still a typo and refused; a malformed version is refused.
  writeFileSync(file, JSON.stringify({ ...raw, futureTop: 1 }));
  expect(() => loadRegistry(f.home)).toThrow("unknown key futureTop");
  writeFileSync(file, JSON.stringify({ ...raw, version: CONFIG_VERSION, futureTop: 1 }));
  expect(() => loadRegistry(f.home)).toThrow("unknown key futureTop");
  writeFileSync(file, JSON.stringify({ ...raw, version: "2" }));
  expect(() => loadRegistry(f.home)).toThrow("config.version");
});

test("AC3: the index file is named per link-resolution version, so versions alternating on one vault never share it", () => {
  const f = fixture(), spec = loadRegistry(f.home).vaults[0]!;
  const first = new VaultIndex(f.home, spec);
  try { expect(first.scan().changed).toBe(3); } finally { first.close(); }
  expect(readdirSync(join(f.home, "indexes"))).toEqual([expect.stringMatching(new RegExp(`^[0-9a-f]{64}-links${LINK_RESOLUTION}\\.sqlite$`))]);
  // 0.2.4 keeps its unversioned `<digest>.sqlite`; writing one beside ours leaves our index warm.
  const name = readdirSync(join(f.home, "indexes"))[0]!, legacy = new Database(join(f.home, "indexes", name.replace(/-links\d+/, "")));
  legacy.run("PRAGMA user_version = 1"); legacy.close();
  const second = new VaultIndex(f.home, spec);
  try { expect(second.scan()).toMatchObject({ notes: 3, changed: 0, removed: 0 }); } finally { second.close(); }
  const db = new Database(join(f.home, "indexes", name), { readonly: true });
  try { expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(LINK_RESOLUTION); } finally { db.close(); }
});

test("AC5: `vmem manifest --json` lists the version, the MCP tools and the CLI commands", () => {
  const result = Bun.spawnSync([process.execPath, "bin/vmem.js", "manifest", "--json"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(result.stdout.toString());
  expect(manifest).toEqual({ name: "@staix/vault-mem", version: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version, configVersion: CONFIG_VERSION,
    mcp: { server: "vmem", tools: [...VMEM_TOOL_NAMES] }, commands: COMMANDS.map(c => c.name) });
  expect(() => run(["manifest", "extra"])).toThrow("unexpected arguments");
});

test("setup --root registers a versioned install root and leaves the current registration until applied", () => {
  const f = fixture(), host = join(f.root, "host"); mkdirSync(host);
  const dir = release(f.root, "9.9.3"), current = join(f.root, "releases", "current"); symlinkSync(dir, current);
  const env = { HOME: host, VMEM_HOME: f.home, AGENTHUB_HOME: join(f.root, "hub") }, claude = join(host, ".claude.json");
  const dry = runSetup("claude", "dry-run", { home: f.home, env, root: current });
  // The link resolves to the release it names, so a later `current` switch never changes a running host.
  expect(dry.root).toEqual({ path: dir, version: "9.9.3" });
  expect(dry.entry.args).toEqual(["--smol", join(dir, "bin", "vmem.js"), "mcp"]);
  expect(dry.console).toMatchObject({ module: join(dir, "src", "ui", "plugin.ts"), change: "add" });
  expect(existsSync(claude)).toBe(false);
  runSetup("claude", "apply", { home: f.home, env, root: dir });
  expect(JSON.parse(readFileSync(claude, "utf8")).mcpServers.vmem.args[1]).toBe(join(dir, "bin", "vmem.js"));
  expect(() => runSetup("claude", "dry-run", { home: f.home, env, root: "releases/9.9.3" })).toThrow("absolute");
  expect(() => runSetup("claude", "dry-run", { home: f.home, env, root: f.home })).toThrow("package.json");
  expect(JSON.parse(run(["setup", "claude", "--root", dir, "--json"], env).text)).toMatchObject({ mode: "dry-run", root: { version: "9.9.3" }, actions: [{ change: "unchanged" }] });
  expect(() => run(["setup", "claude", "--root"], env)).toThrow("value required");
});
