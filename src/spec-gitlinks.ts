import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, memoryGitArgv, memoryGitEnv } from "./platform.ts";

export interface GitlinkScan { matched: boolean; bytes: number; records: number }
interface ScanLimits { bytes: number; records: number; recordBytes: number; timeout: number }
const LIMITS: ScanLimits = { bytes: 128 * 1024 * 1024, records: 1_000_000, recordBytes: 64 * 1024, timeout: 10_000 };
const key = (value: string) => canonicalPath(value).normalize("NFC").toLowerCase();
const advice = "inspect git ls-files --stage for an oversized or slow index, reduce or repair index entries, then retry the create";
function failure(code: "LIMIT" | "IO", message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }

/** Stream the native index, retaining one bounded record and only the ancestor match. */
export function scanGitlinkAncestors(root: string, ancestors: string[], env: NodeJS.ProcessEnv, limits: ScanLimits = LIMITS): Promise<GitlinkScan> {
  const keys = new Set(ancestors.map(ancestor => key(join(root, ancestor))));
  const argv = memoryGitArgv(["-C", root, "ls-files", "--stage", "-z"]);
  const gitEnv = memoryGitEnv({ ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true });
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
    const result: GitlinkScan = { matched: false, bytes: 0, records: 0 };
    let pending = Buffer.alloc(0), diagnostic = "", error: Error | undefined;
    const stop = (cause: Error) => { if (!error) { error = cause; child.kill("SIGKILL"); } };
    const timer = setTimeout(() => stop(failure("LIMIT", `gitlink index scan exceeded its ${limits.timeout} ms time bound; ${advice}`)), limits.timeout);
    child.on("error", cause => stop(failure("IO", `gitlink index scan could not start (${(cause as NodeJS.ErrnoException).code ?? "spawn failure"}); check Git installation and PATH before retrying the create`)));
    child.stdout.on("error", cause => stop(failure("IO", `gitlink index stream failed (${(cause as NodeJS.ErrnoException).code ?? "read failure"}); inspect repository access and retry the create`)));
    child.stderr.on("error", cause => stop(failure("IO", `gitlink diagnostic stream failed (${(cause as NodeJS.ErrnoException).code ?? "read failure"}); inspect repository access and retry the create`)));
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostic.length < 1024) diagnostic += chunk.subarray(0, 1024 - diagnostic.length).toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (error) return;
      result.bytes += chunk.length;
      if (result.bytes > limits.bytes) return stop(failure("LIMIT", `gitlink index scan exceeded its ${limits.bytes}-byte index bound; ${advice}`));
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0, end: number;
      while ((end = data.indexOf(0, start)) !== -1) {
        if (end - start > limits.recordBytes) return stop(failure("LIMIT", `gitlink index record exceeded its ${limits.recordBytes}-byte bound; ${advice}`));
        if (++result.records > limits.records) return stop(failure("LIMIT", `gitlink index scan exceeded its ${limits.records}-entry index bound; ${advice}`));
        const entry = data.subarray(start, end);
        if (entry.subarray(0, 7).toString() === "160000 ") {
          const tab = entry.indexOf(9);
          if (tab < 0) return stop(failure("IO", "gitlink index record has no path separator; repair the Git index and retry the create"));
          if (keys.has(key(join(root, entry.subarray(tab + 1).toString("utf8"))))) result.matched = true;
        }
        start = end + 1;
      }
      pending = Buffer.from(data.subarray(start));
      if (pending.length > limits.recordBytes) stop(failure("LIMIT", `gitlink index record exceeded its ${limits.recordBytes}-byte bound; ${advice}`));
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (error) return reject(error);
      if (status !== 0) return reject(failure("IO", `gitlink index scan failed (exit ${status ?? "unavailable"}, signal ${signal ?? "none"}): ${diagnostic.split(/\r?\n/, 1)[0]?.split(root).join("<path>") || "no diagnostic"}; inspect git ls-files --stage and repair repository access or the index before retrying the create`));
      if (pending.length) return reject(failure("IO", "gitlink index stream ended with an incomplete record; repair the Git index and retry the create"));
      resolve(result);
    });
  });
}

/** Keep the synchronous writer API; the child drains Git asynchronously and returns a compact receipt. */
export function specGitlinkAncestors(root: string, ancestors: string[], env: NodeJS.ProcessEnv): GitlinkScan {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), root], { input: JSON.stringify(ancestors.at(-1) ?? ""), env, timeout: LIMITS.timeout + 5000, detached: true, maxBuffer: 16 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  // The worker owns this process group. Reap descendants even if its event loop
  // could not run the inner timeout (for example during a slow filesystem call).
  if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw failure("IO", `gitlink worker process-group cleanup failed (${(error as NodeJS.ErrnoException).code ?? "signal failure"}); inspect owned process group ${child.pid} and end its remaining Git processes before retrying the create`);
    }
  }
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    throw failure(code === "ETIMEDOUT" ? "LIMIT" : "IO", `gitlink scan worker failed (${code ?? "spawn failure"}); inspect runtime availability and the repository index, then retry the create`);
  }
  try {
    const reply = JSON.parse(child.stdout.toString("utf8"));
    if (child.status !== 0 || !reply || typeof reply.matched !== "boolean" || !Number.isSafeInteger(reply.bytes) || !Number.isSafeInteger(reply.records)) {
      if (reply?.code === "LIMIT" || reply?.code === "IO") throw failure(reply.code, String(reply.message));
      throw new Error("invalid worker receipt");
    }
    return reply as GitlinkScan;
  } catch (error) {
    if ((error as { code?: unknown })?.code) throw error;
    throw failure("IO", "gitlink scan worker returned an invalid receipt; inspect the runtime installation and Git index before retrying the create");
  }
}

if (import.meta.main) {
  try {
    const root = process.argv[2];
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw failure("IO", "gitlink scan request exceeds its protocol size; check the runtime installation before retrying the create");
      chunks.push(chunk);
    }
    const deepest: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!root || typeof deepest !== "string") throw failure("IO", "gitlink scan request is invalid; check the runtime installation before retrying the create");
    const parts = deepest.split("/");
    const ancestors = deepest ? parts.map((_, index) => parts.slice(0, index + 1).join("/")) : [];
    console.log(JSON.stringify(await scanGitlinkAncestors(root, ancestors, process.env)));
  } catch (error) {
    console.log(JSON.stringify({ code: (error as { code?: unknown })?.code === "LIMIT" ? "LIMIT" : "IO", message: error instanceof Error ? error.message : "gitlink scan failed; inspect the Git index before retrying the create" }));
    process.exitCode = 1;
  }
}
