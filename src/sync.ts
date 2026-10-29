import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import { loadRegistry } from "./registry.ts";
import { memoryGitArgv, memoryGitEnv } from "./platform.ts";
import type { WriteIssue } from "./write-types.ts";

/** Paths sync may stage; everything else in the clone is left alone (and reported). */
const STAGE_PREFIXES = ["notes/", "reports/"];
const STAGE_FILES = ["log"];
const GIT_TIMEOUT_MS = 60_000;
export interface SyncResult {
  ok: boolean;
  applied: boolean;
  preview?: boolean;
  vault: string;
  remote: { configured: string | null; origin: string | null; matches: boolean };
  branch: string | null;
  /** Planned changed paths that will be staged and committed. */
  paths: string[];
  /** Changed paths outside notes/, reports/ and log: never staged. */
  ignored: string[];
  ahead: number;
  behind: number;
  fingerprint?: string;
  commit?: string;
  pushed?: boolean;
  issues: WriteIssue[];
}
type Git = (args: string[], options?: { allowFail?: boolean }) => SpawnSyncReturns<string>;
const issue = (code: string, message: string): WriteIssue => ({ code, severity: "error", message });
/** Compare remotes after removing transport noise: scheme, credentials, trailing .git and slash. */
export function sameRemote(a: string, b: string): boolean {
  const norm = (url: string) => {
    let value = url.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try { const parsed = new URL(value); value = parsed.protocol === "file:" ? parsed.pathname : `${parsed.hostname}${parsed.port && !["22", "443"].includes(parsed.port) ? `:${parsed.port}` : ""}${parsed.pathname}`; }
      catch { return value; }
    } else if (/^[^/@:]+@[^:]+:/.test(value) || /^[^/:]+:[^/]/.test(value)) value = value.replace(/^[^@]+@/, "").replace(":", "/");
    return value.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}
function gitIn(cwd: string, env: NodeJS.ProcessEnv): Git {
  return (args, options = {}) => {
    const argv = memoryGitArgv(["-C", cwd, ...args]);
    const result = Bun.spawnSync(argv, { env: memoryGitEnv({ ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true }), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
    const out = { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), pid: result.pid, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
    if (!options.allowFail && result.exitCode !== 0) throw Object.assign(new Error(`git ${args[0]} failed: ${out.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? "error"}`), { git: true });
    return out;
  };
}
function planned(path: string): boolean { return STAGE_FILES.includes(path) || STAGE_PREFIXES.some(prefix => path.startsWith(prefix)); }
/** Parse `status --porcelain=v1 -z` into changed paths (renames contribute both sides). */
function changed(git: Git): string[] {
  const parts = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.split("\0").filter(Boolean), paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!, code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes("R") || code.includes("C")) paths.push(parts[++i]!);
  }
  return [...new Set(paths)].sort();
}

/**
 * Explicit, never scheduled publication of one vault clone. Without `confirm` it fetches, checks the
 * configured remote against `origin`, and previews what would be staged; nothing is committed or pushed.
 * With `confirm` and the current fingerprint it stages only notes/, reports/ and log, commits, rebases on
 * the upstream and pushes. Any failure (remote mismatch, divergence that cannot rebase, push refused,
 * missing credentials) is reported with `ok: false`; it never reports success it did not observe.
 */
export function syncVault(home: string, request: { vault: string; confirm?: boolean; fingerprint?: string; message?: string }, options: { env?: NodeJS.ProcessEnv } = {}): SyncResult {
  const spec = loadRegistry(home).vaults.find(v => v.id === request.vault);
  const result: SyncResult = { ok: false, applied: false, vault: request.vault, remote: { configured: spec?.remote ?? null, origin: null, matches: false }, branch: null, paths: [], ignored: [], ahead: 0, behind: 0, issues: [] };
  if (!spec) return { ...result, issues: [issue("V04", "unknown vault id")] };
  if (!spec.remote) return { ...result, issues: [issue("SYNC", "vault has no configured remote; register it with --remote")] };
  if (spec.write === "none") return { ...result, issues: [issue("POLICY", "vault write policy refuses sync")] };
  const root = realpathSync(spec.path);
  if (root !== spec.path) return { ...result, issues: [issue("V04", "registered vault path changed")] };
  const git = gitIn(root, options.env ?? process.env);
  try {
    if (realpathSync(git(["rev-parse", "--show-toplevel"]).stdout.trim()) !== root) return { ...result, issues: [issue("SYNC", "vault path is not the root of its git repository")] };
    const origin = git(["remote", "get-url", "origin"], { allowFail: true });
    result.remote.origin = origin.status === 0 ? origin.stdout.trim() : null;
    result.remote.matches = result.remote.origin !== null && sameRemote(result.remote.origin, spec.remote);
    if (!result.remote.matches) return { ...result, issues: [issue("REMOTE", result.remote.origin === null ? "repository has no origin remote" : "origin does not match the configured remote; nothing was fetched or pushed")] };
    const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
    if (branch.status !== 0) return { ...result, issues: [issue("SYNC", "detached HEAD; check out a branch first")] };
    result.branch = branch.stdout.trim();
    if (git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { allowFail: true }).status === 0 || git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFail: true }).status === 0) return { ...result, issues: [issue("SYNC", "a rebase or merge is in progress; resolve it first")] };
    const fetch = git(["fetch", "--quiet", "--no-tags", "origin", result.branch], { allowFail: true });
    if (fetch.status !== 0) return { ...result, issues: [issue("FETCH", `fetch failed: ${fetch.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? "error"}`)] };
    const upstream = `origin/${result.branch}`;
    const hasUpstream = git(["rev-parse", "--verify", "--quiet", `refs/remotes/${upstream}`], { allowFail: true }).status === 0;
    if (hasUpstream) {
      const [behind, ahead] = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).stdout.trim().split(/\s+/).map(Number);
      result.behind = behind ?? 0; result.ahead = ahead ?? 0;
    }
    const all = changed(git);
    result.paths = all.filter(planned); result.ignored = all.filter(path => !planned(path));
    const head = git(["rev-parse", "HEAD"], { allowFail: true }).stdout.trim();
    const remoteHead = hasUpstream ? git(["rev-parse", upstream]).stdout.trim() : null;
    const contents = result.paths.map(path => [path, git(["hash-object", "--", path], { allowFail: true }).stdout.trim()]);
    result.fingerprint = createHash("sha256").update(JSON.stringify({ vault: spec.id, remote: spec.remote, branch: result.branch, head, remoteHead, contents })).digest("hex");
    if (request.confirm !== true) return { ...result, ok: true, preview: true };
    if (request.fingerprint !== result.fingerprint) return { ...result, issues: [issue("V09", "stale or missing preview fingerprint")] };
    if (result.paths.length) {
      git(["add", "--", ...result.paths]);
      const message = request.message ?? `vmem sync: ${result.paths.length} path${result.paths.length === 1 ? "" : "s"}`;
      git(["-c", "user.useConfigOnly=false", "commit", "--quiet", "--no-verify", "-m", message, "--", ...result.paths]);
      result.commit = git(["rev-parse", "HEAD"]).stdout.trim();
    }
    if (hasUpstream && result.behind > 0) {
      const rebase = git(["rebase", "--quiet", upstream], { allowFail: true });
      if (rebase.status !== 0) {
        git(["rebase", "--abort"], { allowFail: true });
        return { ...result, applied: Boolean(result.commit), issues: [issue("DIVERGED", "local and remote histories conflict; the local commit was kept and nothing was pushed. Resolve with git, then sync again")] };
      }
    }
    if (!result.commit && (!hasUpstream ? false : git(["rev-list", "--count", `${upstream}..HEAD`]).stdout.trim() === "0")) return { ...result, ok: true, applied: false, pushed: false };
    const push = git(["push", "--quiet", "--porcelain", "origin", `HEAD:refs/heads/${result.branch}`], { allowFail: true });
    if (push.status !== 0) return { ...result, applied: Boolean(result.commit), pushed: false, issues: [issue("PUSH", `push failed: ${push.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? "error"}; the local commit was kept`)] };
    // Verify the remote really has our head before reporting success.
    git(["fetch", "--quiet", "--no-tags", "origin", result.branch]);
    const pushedHead = git(["rev-parse", upstream]).stdout.trim(), localHead = git(["rev-parse", "HEAD"]).stdout.trim();
    if (pushedHead !== localHead) return { ...result, applied: true, pushed: false, issues: [issue("PUSH", "remote head does not match the pushed commit")] };
    return { ...result, ok: true, applied: true, pushed: true, commit: localHead };
  } catch (error) {
    return { ...result, issues: [issue("SYNC", error instanceof Error ? error.message.slice(0, 400) : "git failed")] };
  }
}
