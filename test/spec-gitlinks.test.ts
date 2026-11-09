import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGitArgv, memoryGitEnv } from "../src/platform.ts";
import { scanGitlinkAncestors } from "../src/spec-gitlinks.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-gitlinks-stream-"))); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const env = { HOME: root, PATH: process.env.PATH };
  const git = (args: string[], input?: string) => {
    const argv = memoryGitArgv(["-C", repo, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    const child = spawnSync(argv[0]!, argv.slice(1), { input, env: memoryGitEnv(env, { repositoryIsolation: true }), timeout: 10000, maxBuffer: 65536 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr.toString()).toBe(0);
    return child.stdout.toString().trim();
  };
  git(["-c", "init.templateDir=", "init", "--quiet"]);
  writeFileSync(join(repo, "source.ts"), "synthetic source\n"); git(["add", "."]); git(["commit", "-qm", "Synthetic index stream"]);
  const blob = git(["rev-parse", "HEAD:source.ts"]), commit = git(["rev-parse", "HEAD"]);
  git(["update-index", "--index-info"], Array.from({ length: 2000 }, (_, index) => `100644 ${blob}\tsrc/sibling-${index}.ts\n`).join("") + `160000 ${commit}\tCafé/Café\n`);
  return { repo, env };
}

test("index scan drains more than a pipe buffer and matches only canonical gitlink ancestors", async () => {
  const f = fixture();
  const result = await scanGitlinkAncestors(f.repo, ["Café", "Café/Café"], f.env);
  expect(result.matched).toBe(true); expect(result.bytes).toBeGreaterThan(64 * 1024); expect(result.records).toBe(2002);
  expect((await scanGitlinkAncestors(f.repo, ["src", "src/new"], f.env)).matched).toBe(false);
});
for (const [name, changes, cause] of [
  ["bytes", { bytes: 1024 }, "1024-byte index bound"],
  ["records", { records: 1000 }, "1000-entry index bound"],
  ["record", { recordBytes: 16 }, "16-byte bound"],
] as const) test(`index scan refuses a genuine ${name} bound with recovery guidance`, async () => {
  const f = fixture();
  const result = scanGitlinkAncestors(f.repo, ["src"], f.env, Object.assign({ bytes: 128 * 1024 * 1024, records: 1_000_000, recordBytes: 64 * 1024, timeout: 10000 }, changes));
  const error = await result.catch(error => error as Error & { code: string });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { code: string }).code).toBe("LIMIT");
  expect((error as Error).message).toContain(cause);
  expect((error as Error).message).toMatch(/inspect git ls-files.*reduce or repair.*retry/);
});

test("outer worker timeout also ends its owned Git process group", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-gitlinks-timeout-"))); roots.push(root);
  const pidFile = join(root, "pids.json");
  const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/spec-gitlinks-worker-timeout.ts"), "parent", pidFile], { timeout: 5000, maxBuffer: 65536 });
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { worker: number; git: number };
  try {
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ code: "LIMIT", message: expect.stringContaining("ETIMEDOUT") });
    const state = spawnSync("ps", ["-p", String(pids.git), "-o", "stat="], { encoding: "utf8" });
    // An exited orphan may briefly remain a zombie until the system reaps it.
    expect(state.stdout.trim() === "" || state.stdout.trim().startsWith("Z")).toBe(true);
  } finally {
    try { process.kill(-pids.worker, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});
