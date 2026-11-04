import { spawnSync } from "node:child_process";
import { memoryGitArgv, memoryGitEnv } from "./platform.ts";

const SPEC_GIT_TIMEOUT_MS = 10000;

export interface SpecGitOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  allowedExitCodes?: readonly number[];
  discovery?: boolean;
}
export interface SpecGitResult { status: number; stdout: Buffer; stderr: Buffer }
/** Internal bounded Git inspection, shared by discovery and validation; callers build readonly argv. */
export function specGit(root: string, args: string[], options: SpecGitOptions = {}): SpecGitResult {
  const argv = memoryGitArgv(["-C", root, ...args]), maxBuffer = options.maxBuffer ?? 65536;
  const env = memoryGitEnv({ ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true });
  for (const key of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete env[key];
  const result = spawnSync(argv[0]!, argv.slice(1), { env, timeout: SPEC_GIT_TIMEOUT_MS, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new Error(`spec source: git inspection timed out after ${SPEC_GIT_TIMEOUT_MS} ms${result.signal ? ` (signal ${result.signal})` : ""}; retry and check for a locked repository or slow mount`, { cause: result.error });
    if (code === "ENOBUFS") {
      const advice = options.discovery ? "ignore large or vendored Markdown via .gitignore and untrack already-tracked excluded files with git rm --cached before retrying" : "make SPEC.md paths more specific, or inspect the failed Git command if its output is unexpected, before retrying";
      throw new Error(`spec source: git output exceeded ${maxBuffer} bytes; ${advice}`, { cause: result.error });
    }
    if (code === "E2BIG") throw new Error("spec source: git arguments exceed the platform limit; shorten the paths list before retrying", { cause: result.error });
    throw new Error(`spec source: git could not run (${code ?? "spawn failure"}); install git or fix PATH before retrying`, { cause: result.error });
  }
  const status = result.status;
  if (status === null) throw new Error(`spec source: git inspection timed out or was interrupted (signal ${result.signal ?? "unavailable"}; inspection timeout ${SPEC_GIT_TIMEOUT_MS} ms, parent/test timeout may be shorter); inspect git -C <path> rev-parse --show-toplevel and repair the repository or ownership configuration`);
  if (!(options.allowedExitCodes ?? [0]).includes(status)) {
    const first = result.stderr.toString("utf8").split(/\r?\n/, 1)[0]?.split(root).join("<path>").slice(0, 240) || "no diagnostic";
    throw new Error(`spec source: git refused inspection (exit ${status}): ${first}; inspect git -C <path> rev-parse --show-toplevel and repair the repository or ownership configuration`);
  }
  return { status, stdout: result.stdout, stderr: result.stderr };
}
