import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { localSyncPending } from "../src/sync.ts";
import { plugin } from "../src/ui/plugin.ts";
import type { ConsoleProvider, InboxItem } from "@staix/agent-console/contract";

const roots: string[] = [], cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const moc = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
async function fixture(options: { upstream?: boolean; broken?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-sync-inbox-"))); roots.push(root);
  const home = join(root, "state"), org = join(root, "org"), personal = join(root, "personal");
  for (const dir of [org, personal]) {
    mkdirSync(join(dir, "notes"), { recursive: true }); writeFileSync(join(dir, "notes", "research.md"), moc);
    git(dir, "init", "--quiet", "-b", "main"); git(dir, "add", "."); git(dir, "commit", "--quiet", "-m", "fixture");
  }
  if (options.upstream !== false) {
    const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", "-b", "main", remote);
    git(org, "remote", "add", "origin", remote); git(org, "push", "--quiet", "-u", "origin", "main");
  }
  if (options.broken) {
    const broken = join(root, "broken"); mkdirSync(join(broken, "notes"), { recursive: true });
    addVault(home, { id: "broken", path: broken, kind: "org", write: "cli" });
  }
  addVault(home, { id: "team", path: org, kind: "org", write: "cli" });
  addVault(home, { id: "mine", path: personal, kind: "personal", write: "mcp" });
  const env = { VMEM_HOME: home, AMEM_HOME: join(root, "memory"), AGENTHUB_HOME: join(root, "family") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  cleanups.push(() => { for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const logs: string[] = [];
  const provider = await plugin.open({ home: env.AGENTHUB_HOME, log: message => { logs.push(message); } });
  return { root, home, org, personal, logs, provider };
}
async function syncItems(provider: ConsoleProvider) {
  const result = await provider.snapshot({ panel: "inbox", after: 0 }) as { items: InboxItem[] };
  return result.items.filter(item => item.kind === "sync");
}

test("clean org vault has no sync alert; dirty personal vault is not scanned for sync", async () => {
  const f = await fixture(); writeFileSync(join(f.personal, "private.txt"), "Synthetic personal change.\n");
  const spawn = spyOn(Bun, "spawnSync"); cleanups.push(() => spawn.mockRestore());
  expect(await syncItems(f.provider)).toEqual([]);
  const calls = spawn.mock.calls.map(args => args[0]).filter(Array.isArray) as string[][];
  expect(calls.some(args => args.includes(f.personal))).toBe(false);
  expect(localSyncPending(f.org)).toEqual({ changed: 0, ahead: 0 });
});

test("uncommitted paths produce a stable alert, without verbs, network commands, prompts or Git writes", async () => {
  const f = await fixture(); writeFileSync(join(f.org, "draft.txt"), "Synthetic org change.\n");
  const index = readFileSync(join(f.org, ".git", "index"));
  const spawn = spyOn(Bun, "spawnSync"); cleanups.push(() => spawn.mockRestore());
  const [item] = await syncItems(f.provider);
  expect(item).toMatchObject({ id: "sync:team", group: "alert", kind: "sync", title: "1 unsynced change in team", verbs: [], link: { panel: "overview", params: { vault: "team" } } });
  expect(item!.at).toBeTruthy();
  const calls = spawn.mock.calls.filter(args => Array.isArray(args[0]) && (args[0] as string[]).includes(f.org));
  expect(calls.length).toBeGreaterThan(0);
  for (const args of calls) {
    const argv = args[0] as string[], options = args[1] as { env: Record<string, string>; timeout: number };
    expect(["rev-parse", "status", "symbolic-ref", "for-each-ref", "rev-list"]).toContain(argv[argv.indexOf("-C") + 2]!);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0"); expect(options.env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(1000);
  }
  const count = calls.length;
  await Bun.sleep(5);
  expect((await syncItems(f.provider))[0]!.at).toBe(item!.at);
  expect(spawn.mock.calls.filter(args => Array.isArray(args[0]) && (args[0] as string[]).includes(f.org))).toHaveLength(count);
  expect(readFileSync(join(f.org, ".git", "index"))).toEqual(index);
  expect(existsSync(join(f.org, ".git", "index.lock"))).toBe(false);
});

test("local commits ahead of tracking ref count alongside dirty paths, using local refs only", async () => {
  const f = await fixture(); writeFileSync(join(f.org, "committed.txt"), "Synthetic committed change.\n");
  git(f.org, "add", "."); git(f.org, "commit", "--quiet", "-m", "local only");
  writeFileSync(join(f.org, "uncommitted.txt"), "Synthetic worktree change.\n");
  // A tracking ref stays usable even when the configured remote is unreachable.
  git(f.org, "remote", "set-url", "origin", "ssh://unreachable.example.invalid/vault.git");
  expect(localSyncPending(f.org)).toEqual({ changed: 1, ahead: 1 });
  expect(await syncItems(f.provider)).toMatchObject([{ title: "2 unsynced changes in team", detail: "1 uncommitted paths; 1 local commits ahead of upstream" }]);
});

test("no upstream counts only uncommitted changes, including an unborn branch", async () => {
  const f = await fixture({ upstream: false });
  writeFileSync(join(f.org, "committed.txt"), "Synthetic commit.\n"); git(f.org, "add", "."); git(f.org, "commit", "--quiet", "-m", "untracked history");
  expect(localSyncPending(f.org)).toEqual({ changed: 0, ahead: 0 });
  expect(await syncItems(f.provider)).toEqual([]);
  const unborn = join(f.root, "unborn"); mkdirSync(unborn); git(unborn, "init", "--quiet", "-b", "main"); writeFileSync(join(unborn, "draft.txt"), "Synthetic draft.\n");
  expect(localSyncPending(unborn)).toEqual({ changed: 1, ahead: 0 });
});

test("a Git failure logs and skips only that vault, and failures are cached", async () => {
  const f = await fixture({ broken: true }); writeFileSync(join(f.org, "draft.txt"), "Synthetic change.\n");
  const spawn = spyOn(Bun, "spawnSync"); cleanups.push(() => spawn.mockRestore());
  expect((await syncItems(f.provider)).map(item => item.id)).toEqual(["sync:team"]);
  expect(f.logs.filter(line => line.includes("sync pending broken failed"))).toHaveLength(1);
  const count = spawn.mock.calls.length;
  expect((await syncItems(f.provider)).map(item => item.id)).toEqual(["sync:team"]);
  expect(f.logs.filter(line => line.includes("sync pending broken failed"))).toHaveLength(1);
  expect(spawn.mock.calls.length).toBe(count);
});

test("cached state refreshes after 60 seconds and count changes keep the first-seen time", async () => {
  const f = await fixture(); writeFileSync(join(f.org, "first.txt"), "Synthetic first change.\n");
  const now = Date.now(), clock = spyOn(Date, "now").mockReturnValue(now); cleanups.push(() => clock.mockRestore());
  const [first] = await syncItems(f.provider);
  writeFileSync(join(f.org, "second.txt"), "Synthetic second change.\n");
  clock.mockReturnValue(now + 5000);
  expect((await syncItems(f.provider))[0]!.title).toBe("1 unsynced change in team");
  clock.mockReturnValue(now + 60001);
  const [second] = await syncItems(f.provider);
  expect(second!.title).toBe("2 unsynced changes in team"); expect(second!.at).toBe(first!.at);
  rmSync(join(f.org, "first.txt")); rmSync(join(f.org, "second.txt"));
  clock.mockReturnValue(now + 120002);
  expect(await syncItems(f.provider)).toEqual([]);
});
