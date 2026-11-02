import { isAbsolute, posix, win32 } from "node:path";
import { specGit } from "./spec-git.ts";
import type { SpecCandidate, SpecDocument, SpecSnapshot } from "./spec-source.ts";
import type { SpecValidationIssue } from "./spec-validate.ts";

export interface SpecFreshnessEntry { path: string; id?: string; state: "fresh" | "stale"; commits: number; dirty: boolean }
export interface SpecFreshnessReport { items: SpecFreshnessEntry[]; issues: SpecValidationIssue[] }
export interface SpecFreshnessOptions { env?: NodeJS.ProcessEnv }
const PATH_OUTPUT_BYTES = 8 * 1024 * 1024;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ordered = <T extends { path: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => compare(a.path.normalize("NFC"), b.path.normalize("NFC")) || compare(a.path, b.path));
const idOf = (candidate: SpecCandidate): { id?: string } => typeof candidate.frontmatter.id === "string" && candidate.frontmatter.id.trim().length > 0 ? { id: candidate.frontmatter.id } : {};
function issue(candidate: SpecCandidate, code: string, field: string, message: string): SpecValidationIssue {
  return { code, severity: "error", path: candidate.path, ...idOf(candidate), field, message };
}
function pathsShape(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.length > 0);
}
/** Strip only Git's magic header for the relative/no-parent check; Git interprets the original pathspec. */
function pathspecBody(value: string): string | undefined {
  if (value.startsWith(":(")) {
    const end = value.indexOf(")");
    return end < 0 ? undefined : value.slice(end + 1);
  }
  return value.startsWith(":") ? value.replace(/^:[!^/]*:?/, "") : value;
}
function relativePathspec(value: string): boolean {
  const body = pathspecBody(value);
  return body !== undefined && !value.includes("\0") && !isAbsolute(body) && !win32.isAbsolute(body) && !body.split(/[\\/]/).includes("..");
}
function hasPaths(bytes: Buffer): boolean {
  if (bytes.length && bytes[bytes.length - 1] !== 0) throw new Error("spec freshness: Git returned incomplete NUL-delimited paths; retry on a stable repository");
  return bytes.length > 0;
}
function pathRecords(bytes: Buffer): Buffer[] {
  hasPaths(bytes);
  const paths: Buffer[] = [];
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0, start);
    if (end > start) paths.push(bytes.subarray(start, end));
    start = end + 1;
  }
  return paths;
}
type ScopeMatch = { files: Buffer } | { invalid: "syntax" | "unmatched"; diagnostic?: string };
function trackedScope(root: string, paths: string[], options: SpecFreshnessOptions): ScopeMatch {
  // This conflict is known before Git quotes a possibly long pattern into a truncated diagnostic.
  if (paths.some(path => {
    if (!path.startsWith(":(")) return false;
    const magic = path.slice(2, path.indexOf(")")).split(",");
    return magic.includes("literal") && magic.includes("glob");
  })) return { invalid: "syntax" };
  const result = specGit(root, ["ls-files", "--cached", "-z", "--error-unmatch", "--", ...paths], { env: options.env, maxBuffer: PATH_OUTPUT_BYTES, allowedExitCodes: [0, 1, 128] });
  if (result.status === 128) {
    // A library caller may have a stale snapshot: distinguish a broken index from bad scope syntax.
    specGit(root, ["ls-files", "--cached", "-z"], { env: options.env, maxBuffer: PATH_OUTPUT_BYTES });
    const diagnostic = result.stderr.toString("utf8").split(/\r?\n/, 1)[0]?.split(root).join("<path>").slice(0, 240) || "no diagnostic";
    return { invalid: "syntax", diagnostic };
  }
  if (result.status !== 0 || !hasPaths(result.stdout)) return { invalid: "unmatched" };
  return { files: result.stdout };
}
function fullHash(bytes: Buffer): string {
  const value = bytes.toString("utf8").replace(/\n$/, "");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("spec freshness: Git returned an invalid full commit identity; inspect git rev-parse HEAD and repair the repository before retrying");
  return value;
}
function candidatePaths(candidate: SpecCandidate, issues: SpecValidationIssue[]): string[] | undefined {
  const value = candidate.frontmatter.paths;
  if (value === undefined) return undefined;
  if (!pathsShape(value)) {
    issues.push(issue(candidate, "wrong_shape", "paths", "paths must be a nonempty list of nonempty strings; write repository-relative Git pathspecs as a YAML list"));
    return undefined;
  }
  if (!value.every(relativePathspec)) {
    issues.push(issue(candidate, "invalid_paths", "paths", "paths must use well-formed relative Git pathspecs without parent traversal or NUL; correct magic syntax or replace absolute/parent-relative entries with in-repository scopes"));
    return undefined;
  }
  return value;
}

/** Pure metadata checks remain available when callers intentionally disable native Git inspection. */
export function specMetadataIssues(candidate: SpecCandidate): SpecValidationIssue[] {
  const issues: SpecValidationIssue[] = [];
  candidatePaths(candidate, issues);
  const stamp = candidate.frontmatter["verified-against"];
  if (stamp !== undefined && (typeof stamp !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(stamp))) issues.push(issue(candidate, "invalid_verified_against", "verified-against", "verified-against must be a full commit SHA; set it to the full git rev-parse HEAD result after reviewing the spec"));
  return issues;
}

/** Computed freshness only: malformed metadata is reported, while Git operational failures propagate. */
export function specFreshness(snapshot: SpecSnapshot, options: SpecFreshnessOptions = {}): SpecFreshnessReport {
  const items: SpecFreshnessEntry[] = [], issues: SpecValidationIssue[] = [];
  let loadedHead = false, head: string | undefined;
  const stampChecks = new Map<string, string | undefined>();
  const headCommit = () => {
    if (!loadedHead) {
      const result = specGit(snapshot.root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env: options.env, allowedExitCodes: [0, 1] });
      head = result.status === 0 ? fullHash(result.stdout) : undefined;
      loadedHead = true;
    }
    return head;
  };
  const checkStamp = (stamp: string): string | undefined => {
    if (stampChecks.has(stamp)) return stampChecks.get(stamp);
    const current = headCommit();
    let failure: string | undefined;
    const commit = specGit(snapshot.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${stamp}^{commit}`], { env: options.env, allowedExitCodes: [0, 1] });
    if (commit.status !== 0 || fullHash(commit.stdout) !== stamp.toLowerCase()) failure = "verified-against does not name a commit in this repository; choose a full commit SHA from git log after reviewing the spec";
    else if (current === undefined) failure = "verified-against cannot be checked without a HEAD commit; commit the tracked source and review it before recording a verification stamp";
    else if (specGit(snapshot.root, ["merge-base", "--is-ancestor", stamp, current], { env: options.env, allowedExitCodes: [0, 1] }).status !== 0) failure = "verified-against is not an ancestor of HEAD; review the spec against a reachable commit and update the full verification SHA";
    stampChecks.set(stamp, failure);
    return failure;
  };
  for (const candidate of ordered(snapshot.candidates ?? snapshot.specs)) {
    const paths = candidatePaths(candidate, issues);
    let validPaths: string[] | undefined;
    if (paths !== undefined) {
      const scope = trackedScope(snapshot.root, paths, options);
      if ("invalid" in scope) issues.push(issue(candidate, "invalid_paths", "paths", scope.invalid === "syntax"
        ? `paths contain invalid Git pathspec syntax${scope.diagnostic ? ` (${scope.diagnostic})` : ""}; correct the pathspec magic or use a repository-relative tracked path from git ls-files`
        : "one or more paths match no tracked files, or exclusions leave the scope empty; choose matching pathspecs from git ls-files and correct the paths list"));
      else validPaths = paths;
    }
    const stamp = candidate.frontmatter["verified-against"];
    if (stamp === undefined) continue;
    if (typeof stamp !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(stamp)) {
      issues.push(issue(candidate, "invalid_verified_against", "verified-against", "verified-against must be a full commit SHA; set it to the full git rev-parse HEAD result after reviewing the spec"));
      continue;
    }
    const failure = checkStamp(stamp);
    if (failure) { issues.push(issue(candidate, "invalid_verified_against", "verified-against", failure)); continue; }
    if (validPaths === undefined) continue;
    const count = specGit(snapshot.root, ["rev-list", "--count", "--full-history", `${stamp}..${head!}`, "--", ...validPaths], { env: options.env }).stdout.toString("utf8").trim();
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error("spec freshness: Git returned an invalid source commit count; inspect the scoped history before retrying");
    const trackedDirty = specGit(snapshot.root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-only", "-z", head!, "--", ...validPaths], { env: options.env, maxBuffer: PATH_OUTPUT_BYTES }).stdout;
    const stagedDirty = specGit(snapshot.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-only", "-z", head!, "--", ...validPaths], { env: options.env, maxBuffer: PATH_OUTPUT_BYTES }).stdout;
    const untrackedDirty = specGit(snapshot.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...validPaths], { env: options.env, maxBuffer: PATH_OUTPUT_BYTES }).stdout;
    const changedTracked = hasPaths(trackedDirty), changedStaged = hasPaths(stagedDirty), changedUntracked = hasPaths(untrackedDirty);
    const dirty = changedTracked || changedStaged || changedUntracked, commits = Number(count);
    items.push({ path: candidate.path, ...idOf(candidate), state: commits > 0 || dirty ? "stale" : "fresh", commits, dirty });
  }
  return { items, issues };
}

/** Match tracked files through Git's own pathspec engine; invalid metadata has no invented ownership. */
export function specsCoveringPath(snapshot: SpecSnapshot, relativeFile: string, options: SpecFreshnessOptions = {}): SpecDocument[] {
  if (typeof relativeFile !== "string" || !relativeFile || relativeFile.includes("\0") || isAbsolute(relativeFile) || win32.isAbsolute(relativeFile) || relativeFile.split(/[\\/]/).includes("..")) throw new Error("spec coversPath: expected a tracked repository-relative filename without parent traversal or NUL; pass a file listed by git ls-files");
  const file = posix.normalize(relativeFile);
  if (file === ".") return [];
  const requested = specGit(snapshot.root, ["ls-files", "--cached", "-z", "--error-unmatch", "--", `:(literal)${file}`], { env: options.env, maxBuffer: PATH_OUTPUT_BYTES, allowedExitCodes: [0, 1] });
  if (requested.status !== 0) return [];
  // A literal directory pathspec also lists descendants; coversPath accepts a file, not a directory.
  const spelling = file.normalize("NFC").toLowerCase();
  const tracked = pathRecords(requested.stdout).filter(path => path.toString("utf8").normalize("NFC").toLowerCase() === spelling);
  if (!tracked.length) return [];
  return ordered(snapshot.specs).filter(document => {
    const paths = document.frontmatter.paths;
    if (!pathsShape(paths) || !paths.every(relativePathspec)) return false;
    const scope = trackedScope(snapshot.root, paths, options);
    return "files" in scope && pathRecords(scope.files).some(path => tracked.some(file => file.equals(path)));
  });
}
