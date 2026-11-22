import { Report } from "@staix/cli-output";
/**
 * Read-only Git snapshot history for a registered vault (#235). Git commits are snapshot boundaries; this provider
 * never writes, checks out, fetches or reads commit messages/authors. Every object id is a full SHA-1/SHA-256 commit
 * reachable from the vault HEAD, resolved once and pinned for the request. Current note policy (denied paths, UTF-8,
 * symlink and size rules) also applies to historical blobs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isDenied, memoryGitArgv, memoryGitEnv } from "./platform.ts";
import { VaultIndex, MAX_NOTE_BYTES, MAX_READ_BYTES, h2Sections, headingMetadata, readPage } from "./vault-index.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { plural, shellWord, stripTerminal, type TextOptions } from "./text-output.ts";
import type { VaultSpec } from "./config.ts";

export const SNAPSHOT_SCHEMA_VERSION = 1;
/** Note revisions per history page, and commits a single request may scan. */
export const HISTORY_PAGE_LIMIT = 100;
export const HISTORY_SCAN_LIMIT = 1000;
export const CHANGES_PAGE_LIMIT = 500;
/** One Git subprocess deadline per request, shared by every call it makes. */
export const SNAPSHOT_DEADLINE_MS = 5000;
/**
 * A complete CLI/MCP response, envelope and escaping included, stays within 48 KiB. This is the only result cap: it is
 * tighter than the 256 KiB aggregate the transport accepts, so a page is trimmed to fit instead of being refused there.
 */
export const SNAPSHOT_TRANSPORT_BYTES = 48 * 1024;
/**
 * The MCP transport measures a handler's result after stringifying it into the JSON-RPC frame, so every payload byte
 * is counted twice through its escaping. This reserves the frame around it: `{"jsonrpc":"2.0","id":…,"result":
 * {"content":[{"type":"text","text":…}]}}` with a request id of at most 200 characters, plus the newline.
 */
const FRAME_RESERVE = 512;
/** A cursor carries one note path (at most 1024 bytes), up to two commit ids and its JSON keys, base64url-expanded. */
export const SNAPSHOT_CURSOR_CHARS = 4 * (1024 + 64 + 64 + 160);
const LOG_BUFFER_BYTES = 1024 * 1024;
const DIFF_BUFFER_BYTES = 4 * 1024 * 1024;
const BATCH_BUFFER_BYTES = 64 * 1024;
const STATUS_BUFFER_BYTES = 1024 * 1024;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NOTE_PATH = /^notes\/(?:[^/]+\/)*[^/]+\.md$/;
const ZERO_OID = /^0+$/;
type GitOutcome = { status: number | null; stdout: Buffer; stderr: string };
type GitOptions = { input?: string | Buffer; maxBuffer?: number; allowFail?: boolean; env?: NodeJS.ProcessEnv };

/** Why a snapshot read cannot answer, reported as a result rather than as current content. */
export type SnapshotCapability = "not_a_repository" | "vault_not_repository_root" | "git_unavailable" | "no_commits" | "shallow_history" | "object_unavailable";
export interface SnapshotCoverage { complete: boolean; reason?: string }
export interface SnapshotBase {
  schemaVersion: number;
  basis: "git_snapshot";
  vault: string;
  head: string | null;
  firstParent: true;
  renamePolicy: "exact_path";
  timeBasis: "git_commit_metadata_not_assertion_time";
  coverage: SnapshotCoverage;
  capability?: SnapshotCapability;
  dirtyNotes: number | null;
  dirtyNotesReason?: string;
}
export interface HistoryRevision { revision: string; blob: string; bytes: number; committedAt: string }
export type HistoryStopReason = "page_full" | "scan_limit" | "history_end" | "unsupported" | "transport_limit";
export interface HistoryResult extends SnapshotBase {
  path: string;
  revisions: HistoryRevision[];
  scanned: number;
  scanLimit: number;
  pageLimit: number;
  stopReason: HistoryStopReason;
  truncated: boolean;
  continuation?: string;
  skippedSymlink: number;
}
export interface RevisionResult extends SnapshotBase {
  path: string;
  found: boolean;
  revision?: string;
  blob?: string;
  sha256?: string;
  bytes?: number;
  content?: string;
  truncated?: boolean;
  section?: string;
  offset?: number;
  nextOffset?: number;
  headings?: string[];
  headingsTruncated?: boolean;
  transportLimited?: boolean;
}
export type ChangeStatus = "A" | "M" | "D" | "T";
export interface ChangedNote { path: string; status: ChangeStatus; before: string | null; after: string | null }
export interface ChangesResult extends SnapshotBase {
  from: string;
  to: string;
  changed: ChangedNote[];
  total: number;
  truncated: boolean;
  continuation?: string;
  skippedDenied: number;
  skippedSymlink: number;
}
export interface SnapshotRequestBase { vault: VaultSpec; home: string; denyPaths?: readonly string[]; env?: NodeJS.ProcessEnv }
export interface HistoryRequest extends SnapshotRequestBase { note: string; limit?: number; cursor?: string }
export interface RevisionRequest extends SnapshotRequestBase { note: string; revision: string; maxBytes?: number; offset?: number; section?: string }
export interface ChangesRequest extends SnapshotRequestBase { from: string; to: string; limit?: number; cursor?: string }
/** Internal bounds for tests; public surfaces never pass these. */
export interface SnapshotLimits { pageLimit?: number; scanLimit?: number; deadlineMs?: number; transportBytes?: number }

function refuse(message: string, code = "V04"): never { throw Object.assign(new Error(message), { code }); }
function text(value: Buffer): string { return value.toString("utf8"); }
/** The bytes this result costs on the wire: stringified for `--json`, then escaped again inside the MCP frame. */
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(JSON.stringify(value))); }
const fits = (value: unknown, transportBytes: number) => byteLength(value) <= transportBytes - FRAME_RESERVE;
function boundary(bytes: Buffer, proposed: number): number {
  let end = Math.min(proposed, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Hardened Git call: no pager, hooks, fsmonitor, external diff, prompts, lazy fetch or inherited Git directories. The
 * extra `-c` entries pin the three settings a repository can still turn on by itself: `log.follow` renames a path
 * projection, `log.showSignature` runs `gpg.program`, and that program is emptied here as well.
 */
const HARDENED_CONFIG = ["-c", "log.follow=false", "-c", "log.showSignature=false", "-c", "gpg.program="];
function historyGit(root: string, args: string[], deadline: number, options: GitOptions = {}): GitOutcome {
  const remaining = deadline - Date.now();
  if (remaining <= 0) refuse(`snapshot: the ${SNAPSHOT_DEADLINE_MS / 1000} s Git budget is spent; retry once the repository is responsive`, "V09");
  const argv = memoryGitArgv([...HARDENED_CONFIG, "-C", root, ...args]);
  const env = memoryGitEnv({ ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true, readOnlyDiagnostic: true });
  // Literal pathspecs after the projection, which drops every inherited GIT_* key: a note path is never a glob.
  env.GIT_LITERAL_PATHSPECS = "1";
  const result = spawnSync(argv[0]!, argv.slice(1), {
    env, timeout: remaining, maxBuffer: options.maxBuffer ?? 65536, stdio: ["pipe", "pipe", "pipe"],
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: null, stdout: Buffer.alloc(0), stderr: "ENOENT" };
    if (code === "ETIMEDOUT") refuse(`snapshot: Git exceeded the ${SNAPSHOT_DEADLINE_MS / 1000} s subprocess deadline; retry on a responsive repository`, "V09");
    if (code === "ENOBUFS") refuse("snapshot: Git output exceeded its bounded buffer; narrow the request or the revision range", "V09");
    refuse(`snapshot: Git could not run (${code ?? "spawn failure"}); install git or fix PATH`, "GIT");
  }
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ? text(result.stderr) : "";
  if (result.status === null) refuse(`snapshot: Git was terminated (signal ${result.signal ?? "unavailable"}); retry once the repository is responsive`, "V09");
  if (result.status !== 0 && !options.allowFail) {
    const first = stderr.split(/\r?\n/)[0] ?? "no diagnostic";
    refuse(`snapshot: Git refused inspection (exit ${result.status}): ${first.slice(0, 240)}; check the repository with \`git fsck\` and repair it, then retry`, "V09");
  }
  return { status: result.status, stdout, stderr };
}

interface Snapshot {
  root: string;
  head: string;
  shallow: boolean;
  env: NodeJS.ProcessEnv;
  deadline: number;
  git(args: string[], options?: GitOptions): GitOutcome;
}
type Opened = { ok: true; snapshot: Snapshot } | { ok: false; capability: SnapshotCapability; reason?: string };

function openSnapshot(vault: VaultSpec, env: NodeJS.ProcessEnv, limits: SnapshotLimits): Opened {
  const deadline = Date.now() + (limits.deadlineMs ?? SNAPSHOT_DEADLINE_MS);
  let root: string;
  try { root = realpathSync(vault.path); }
  catch { return { ok: false, capability: "not_a_repository", reason: "the vault path is missing or unreadable" }; }
  if (root !== vault.path) refuse(`vault ${vault.id}: registered path changed; re-register it with vmem vaults add and retry`);
  const git = (args: string[], options: GitOptions = {}) => historyGit(root, args, deadline, { ...options, env });
  const top = git(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.status !== 0) {
    if (top.stderr.trim() === "ENOENT") return { ok: false, capability: "git_unavailable", reason: "git is not available on PATH" };
    return { ok: false, capability: "not_a_repository", reason: top.stderr.split(/\r?\n/)[0]?.slice(0, 200) || "not a Git work tree" };
  }
  let toplevel: string;
  try { toplevel = realpathSync(text(top.stdout).trim()); } catch { toplevel = text(top.stdout).trim(); }
  if (toplevel !== root) return { ok: false, capability: "vault_not_repository_root", reason: "the registered vault root is not the repository top level" };
  const shallow = text(git(["rev-parse", "--is-shallow-repository"], { allowFail: true }).stdout).trim() === "true";
  const headOut = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { allowFail: true });
  const head = text(headOut.stdout).trim();
  if (headOut.status !== 0 || !FULL_OID.test(head)) return { ok: false, capability: "no_commits", reason: "the vault HEAD names no commit" };
  return { ok: true, snapshot: { root, head, shallow, env, deadline, git } };
}

function coverageOf(snapshot: Snapshot): SnapshotCoverage {
  return snapshot.shallow ? { complete: false, reason: "shallow_history" } : { complete: true };
}

/**
 * A repository clean filter is a command `.gitattributes` (never the note) selects, and `git status` runs it over every
 * tracked note. `check-attr` only reads attributes, so it decides first whether the count can be taken at all.
 */
function cleanFilterPaths(git: Snapshot["git"]): { filtered: boolean; reason?: string } {
  const listed = git(["ls-files", "-z", "--", "notes"], { allowFail: true, maxBuffer: STATUS_BUFFER_BYTES });
  if (listed.status !== 0) return { filtered: false, reason: "Git could not list the tracked notes" };
  if (!listed.stdout.length) return { filtered: false };
  // The NUL-separated paths go back in as the bytes Git wrote, so a non-UTF-8 filename is not re-encoded.
  const attrs = git(["check-attr", "-z", "--stdin", "filter"], { allowFail: true, input: listed.stdout, maxBuffer: STATUS_BUFFER_BYTES });
  if (attrs.status !== 0) return { filtered: false, reason: "Git could not read the notes attributes" };
  const tokens = text(attrs.stdout).split("\0");
  for (let i = 2; i < tokens.length; i += 3) if (tokens[i] && tokens[i] !== "unspecified") return { filtered: true };
  return { filtered: false };
}

function dirtyNoteCount(git: Snapshot["git"]): { count: number | null; reason?: string } {
  const filter = cleanFilterPaths(git);
  if (filter.filtered) return { count: null, reason: "a clean filter is configured for notes/; the dirty-note count is not taken" };
  if (filter.reason) return { count: null, reason: filter.reason };
  const out = git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "notes"], { allowFail: true, maxBuffer: STATUS_BUFFER_BYTES });
  if (out.status !== 0) return { count: null, reason: "git status is unavailable" };
  const parts = text(out.stdout).split("\0").filter(Boolean);
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    count++;
    if (/[RC]/.test(parts[i]!.slice(0, 2))) i++;
  }
  return { count };
}

/** A full lowercase object id, never a revision expression, prefix or option-like string. */
function fullOid(value: string, label: string): string {
  if (typeof value !== "string" || !FULL_OID.test(value)) {
    refuse(`${label}: expected a full lowercase SHA-1 or SHA-256 commit id; prefixes, revision expressions and option-like input are refused`);
  }
  return value;
}

/**
 * `notes/<path>.md` with no traversal, dot segment, backslash or control character; the only path shape historical
 * reads accept. A control character is refused because Git's own line-oriented plumbing would read it as a second
 * path expression.
 */
function notesPath(value: string): string | undefined {
  if (!NOTE_PATH.test(value) || Buffer.byteLength(value) > 1024 || /[\\\u0000-\u001f]/.test(value)) return undefined;
  const parts = value.split("/").slice(1);
  return parts.some(part => part === "." || part === ".." || part.startsWith(".")) ? undefined : value;
}

/** Literal notes/ path, or the indexed note resolved by stem/alias exactly as `vmem show` does. */
function resolveNote(vault: VaultSpec, home: string, note: string): string {
  const literal = notesPath(note);
  if (literal) return literal;
  const relative = typeof note === "string" ? note.replace(/^notes\//i, "") : "";
  // A target is one note's stem or alias: no path separator, dot segment, backslash or control character.
  if (!relative || Buffer.byteLength(note) > 1024 || /[/\\\u0000-\u001f]/.test(relative) || relative.startsWith(".")) {
    refuse("note: expected a note target or a vault-relative notes/<path>.md path; other paths are not readable");
  }
  const index = new VaultIndex(home, vault, [vault.path], { memory: true });
  try {
    index.scan();
    return `notes/${index.resolve(note)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "note lookup failed";
    if (message.startsWith("note:")) refuse(`${message}; pass the note's notes/<path>.md to read a deleted note's history`);
    throw error;
  } finally { index.close(); }
}

function assertReadable(path: string, root: string, denyPaths: readonly string[]): void {
  if (isDenied(join(root, path), [...denyPaths])) refuse(`path: ${path} is denied by the built-in secret rules or registry denyPaths; nothing read`, "V06");
}

function commitParent(git: Snapshot["git"], commit: string): string | null {
  const out = git(["rev-parse", "--verify", "--quiet", `${commit}^`], { allowFail: true });
  const parent = text(out.stdout).trim();
  return out.status === 0 && FULL_OID.test(parent) ? parent : null;
}

function reachable(git: Snapshot["git"], commit: string, head: string): void {
  const out = git(["merge-base", "--is-ancestor", commit, head], { allowFail: true });
  if (out.status === 1) refuse(`revision: ${commit} is not reachable from the vault HEAD; only commits reachable from HEAD are readable`, "V06");
  if (out.status !== 0) refuse(`revision: reachability of ${commit} could not be checked (exit ${out.status}); inspect the repository`, "V09");
}

/**
 * Whether `commit` sits on `pin`'s own first-parent chain, which is the walk a page continues from. Bounded by the
 * scan limit: a chain longer than the bound cannot be proved, and is refused rather than walked further.
 */
function onFirstParentChain(git: Snapshot["git"], commit: string, pin: string, limit: number): boolean {
  const out = git(["rev-list", "--first-parent", `--max-count=${limit + 1}`, pin], { allowFail: true, maxBuffer: LOG_BUFFER_BYTES });
  if (out.status !== 0) refuse(`cursor: the first-parent chain of ${pin} could not be read (exit ${out.status}); restart without --cursor`, "V09");
  return text(out.stdout).split("\n").some(line => line.trim() === commit);
}

/** Whether one object expression (`<commit>^{commit}` or a blob id) is present in this repository's object store. */
function objectAvailable(git: Snapshot["git"], expression: string): boolean {
  return git(["cat-file", "-e", expression], { allowFail: true }).status === 0;
}

function commitObject(git: Snapshot["git"], value: string, label: string): string {
  const commit = fullOid(value, label);
  if (!objectAvailable(git, `${commit}^{commit}`)) refuse(`revision: ${commit} is not an available commit object; it may be pruned, shallow or belong to another repository. Pick a full commit id from \`vmem history <vault> <note>\``, "V09");
  const resolved = text(git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { allowFail: true }).stdout).trim();
  if (resolved !== commit) refuse(`revision: ${commit} does not name a commit object; pass the full commit id Git reported`, "V04");
  return commit;
}

/** One record per commit that changed the note path, from `git log --first-parent --raw -z`. */
interface RawRecord { revision: string; committedAt: string; mode: string; status: string; blob: string }
function parseLogRaw(output: string, path: string): RawRecord[] {
  const tokens = output.split("\0"), records: RawRecord[] = [];
  let current: { revision: string; committedAt: string } | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.replace(/^\n/, "");
    if (!token) continue;
    if (token.startsWith("\x01")) {
      const [revision, committedAt] = token.slice(1).split("\t");
      current = revision !== undefined && FULL_OID.test(revision) ? { revision, committedAt: committedAt ?? "" } : undefined;
      continue;
    }
    if (!token.startsWith(":") || current === undefined) continue;
    const parts = token.slice(1).split(" ");
    const recordPath = tokens[++i] ?? "";
    if (recordPath !== path) { current = undefined; continue; }
    records.push({ ...current, mode: parts[1] ?? "", status: parts[4] ?? "", blob: parts[3] ?? "" });
    current = undefined;
  }
  return records;
}

interface HistoryCursor { v: 1; kind: "history"; path: string; head: string; after: string }
interface ChangesCursor { v: 1; kind: "changes"; from: string; to: string; after: string }
function encodeCursor(cursor: HistoryCursor | ChangesCursor): string { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeCursor(raw: string): HistoryCursor | ChangesCursor {
  if (typeof raw !== "string" || !raw || raw.length > SNAPSHOT_CURSOR_CHARS) refuse("cursor: expected the opaque continuation from a previous page; restart without --cursor");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { refuse("cursor: not a continuation this provider issued; restart without --cursor"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("cursor: not a continuation this provider issued; restart without --cursor");
  const cursor = value as Record<string, unknown>;
  if (cursor.v !== 1 || (cursor.kind !== "history" && cursor.kind !== "changes") || typeof cursor.after !== "string") {
    refuse("cursor: not a continuation this provider issued; restart without --cursor");
  }
  return cursor as unknown as HistoryCursor | ChangesCursor;
}

function baseResult(vault: VaultSpec, head: string | null, coverage: SnapshotCoverage, extra: Partial<SnapshotBase> = {}): SnapshotBase {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, basis: "git_snapshot", vault: vault.id, head, firstParent: true,
    renamePolicy: "exact_path", timeBasis: "git_commit_metadata_not_assertion_time", coverage, dirtyNotes: null, ...extra };
}

function unsupportedHistory(vault: VaultSpec, path: string, capability: SnapshotCapability, reason?: string): HistoryResult {
  return { ...baseResult(vault, null, { complete: false, reason: reason ?? capability }, { capability, dirtyNotes: null, ...(reason ? { dirtyNotesReason: reason } : {}) }),
    path, revisions: [], scanned: 0, scanLimit: HISTORY_SCAN_LIMIT, pageLimit: HISTORY_PAGE_LIMIT, stopReason: "unsupported", truncated: false, skippedSymlink: 0 };
}

/** The page and the cursor are trimmed until the whole result, envelope included, fits the transport bound. */
function fitHistory(result: HistoryResult, transportBytes: number): HistoryResult {
  if (fits(result, transportBytes)) return result;
  const revisions = [...result.revisions];
  while (revisions.length) {
    revisions.pop();
    const after = revisions.at(-1)?.revision;
    const candidate: HistoryResult = { ...result, revisions, truncated: true, stopReason: revisions.length ? "page_full" : "transport_limit",
      ...(after ? { continuation: encodeCursor({ v: 1, kind: "history", path: result.path, head: result.head ?? "", after }) } : { continuation: undefined }) };
    if (fits(candidate, transportBytes)) return candidate;
  }
  return { ...result, revisions: [], truncated: true, stopReason: "transport_limit", continuation: undefined };
}

/** The longest UTF-8 prefix of `bytes` that fits, or undefined when not even an empty page does. */
function trimContent(base: RevisionResult, bytes: Buffer, transportBytes: number): RevisionResult | undefined {
  const render = (cut: number): RevisionResult => ({ ...base, content: bytes.subarray(0, cut).toString("utf8"), truncated: true,
    ...(cut > 0 ? { nextOffset: (base.offset ?? 0) + cut } : {}), transportLimited: true });
  let low = 0, high = bytes.length, best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1, cut = boundary(bytes, middle);
    if (fits(render(cut), transportBytes)) { best = cut; low = middle + 1; }
    else high = middle - 1;
  }
  return best < 0 ? undefined : render(boundary(bytes, best));
}

/**
 * Content is trimmed first, then the heading list (a page can be heading-heavy while its body is short): both count
 * towards the same bound, and the flag says the list was cut.
 */
function fitRevision(result: RevisionResult, transportBytes: number): RevisionResult {
  if (fits(result, transportBytes)) return result;
  const bytes = Buffer.from(result.content ?? "", "utf8");
  const trimmed = trimContent(result, bytes, transportBytes);
  if (trimmed) return trimmed;
  const dropped = { ...result };
  delete dropped.headings;
  delete dropped.headingsTruncated;
  const base: RevisionResult = { ...dropped, ...(result.headings?.length ? { headingsTruncated: true } : {}) };
  return trimContent(base, bytes, transportBytes) ?? { ...base, content: "", truncated: true, transportLimited: true };
}

function fitChanges(result: ChangesResult, transportBytes: number): ChangesResult {
  if (fits(result, transportBytes)) return result;
  const changed = [...result.changed];
  while (changed.length) {
    changed.pop();
    const after = changed.at(-1)?.path;
    const candidate: ChangesResult = { ...result, changed, truncated: true,
      ...(after ? { continuation: encodeCursor({ v: 1, kind: "changes", from: result.from, to: result.to, after }) } : { continuation: undefined }) };
    if (fits(candidate, transportBytes)) return candidate;
  }
  return { ...result, changed: [], truncated: true, continuation: undefined };
}

/** Bounded read-only history of one note path, newest first, pinned to the HEAD the first page saw. */
export function readHistory(request: HistoryRequest, limits: SnapshotLimits = {}): HistoryResult {
  const env = request.env ?? process.env, denyPaths = request.denyPaths ?? [];
  const pageLimit = limits.pageLimit ?? HISTORY_PAGE_LIMIT, scanLimit = limits.scanLimit ?? HISTORY_SCAN_LIMIT;
  const transportBytes = limits.transportBytes ?? SNAPSHOT_TRANSPORT_BYTES;
  const path = resolveNote(request.vault, request.home, request.note);
  assertReadable(path, request.vault.path, denyPaths);
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > pageLimit)) refuse(`limit: expected integer 1..${pageLimit}`);
  const opened = openSnapshot(request.vault, env, limits);
  if (!opened.ok) return unsupportedHistory(request.vault, path, opened.capability, opened.reason);
  const snapshot = opened.snapshot, dirty = dirtyNoteCount(snapshot.git);
  let pin = snapshot.head, start: string | null = snapshot.head;
  if (request.cursor !== undefined) {
    const cursor = decodeCursor(request.cursor);
    if (cursor.kind !== "history") refuse("cursor: belongs to a changes page; restart without --cursor");
    if (cursor.path !== path) refuse("cursor: belongs to another note path; restart without --cursor");
    pin = commitObject(snapshot.git, cursor.head, "cursor.head");
    reachable(snapshot.git, pin, snapshot.head);
    // A cursor resumes a walk, so the commit it resumes after must be one this walk could have reached.
    const after = commitObject(snapshot.git, cursor.after, "cursor.after");
    if (!onFirstParentChain(snapshot.git, after, pin, scanLimit)) {
      refuse(`cursor: ${after} is not on the first-parent chain of the pinned ${pin}; restart without --cursor`, "V06");
    }
    start = commitParent(snapshot.git, after);
    if (start === null) {
      return { ...baseResult(request.vault, pin, coverageOf(snapshot), { ...(snapshot.shallow ? { capability: "shallow_history" as const } : {}), dirtyNotes: dirty.count, ...(dirty.reason ? { dirtyNotesReason: dirty.reason } : {}) }),
        path, revisions: [], scanned: 0, scanLimit, pageLimit, stopReason: "history_end", truncated: false, skippedSymlink: 0 };
    }
  }
  const perPage = Math.min(request.limit ?? pageLimit, pageLimit);
  // The window bounds commits traversed, not commits that touched the path: `rev-list` walks first-parent, and `log`
  // then projects each of those commits onto this one path without walking any further.
  const walked = text(snapshot.git(["rev-list", "--first-parent", `--max-count=${scanLimit + 1}`, start], { maxBuffer: LOG_BUFFER_BYTES }).stdout)
    .split("\n").map(line => line.trim()).filter(Boolean);
  if (walked.some(commit => !FULL_OID.test(commit))) refuse("snapshot: Git returned an unexpected commit id; retry", "V09");
  const moreCommits = walked.length > scanLimit, traversed = walked.slice(0, scanLimit);
  const out = traversed.length
    ? snapshot.git(["log", "--no-walk=unsorted", "--stdin", "-z", "--first-parent", "--raw", "--no-renames", "--no-textconv", "--no-abbrev",
      "--format=%x01%H%x09%cI", "--", path], { input: `${traversed.join("\n")}\n`, maxBuffer: LOG_BUFFER_BYTES })
    : { status: 0, stdout: Buffer.alloc(0), stderr: "" };
  const parsed = parseLogRaw(text(out.stdout), path);
  const noteRecords = parsed.filter(record => (record.mode === "100644" || record.mode === "100755") && !ZERO_OID.test(record.blob) && record.status !== "D");
  const skippedSymlink = parsed.filter(record => record.mode === "120000").length;
  let incomplete: string | undefined;
  const revisions: HistoryRevision[] = [];
  if (noteRecords.length) {
    // Keyed by the blob id `--raw` reported, never by `<commit>:<path>`: a path is data, not a second expression.
    const batch = snapshot.git(["cat-file", "--batch-check"], { input: `${noteRecords.map(record => record.blob).join("\n")}\n`, maxBuffer: BATCH_BUFFER_BYTES });
    const lines = text(batch.stdout).split("\n");
    for (const [index, record] of noteRecords.entries()) {
      const parts = (lines[index] ?? "").split(" ");
      const blob = parts[0] ?? "", type = parts[1] ?? "", size = Number(parts[2]);
      if (type !== "blob" || blob !== record.blob || !Number.isSafeInteger(size) || size < 0) { incomplete = "object_unavailable"; continue; }
      revisions.push({ revision: record.revision, blob, bytes: size, committedAt: record.committedAt });
    }
  }
  const page = revisions.slice(0, perPage);
  const stopReason: HistoryStopReason = revisions.length > perPage ? "page_full" : moreCommits ? "scan_limit" : "history_end";
  // A scan-limited page with no matching revision still continues: from the oldest commit the window traversed.
  const resume = page.at(-1)?.revision ?? (moreCommits ? traversed.at(-1) : undefined);
  const continuation = stopReason === "history_end" || !resume ? undefined : encodeCursor({ v: 1, kind: "history", path, head: pin, after: resume });
  const result: HistoryResult = {
    ...baseResult(request.vault, pin, incomplete ? { complete: false, reason: incomplete } : coverageOf(snapshot),
      { ...(snapshot.shallow ? { capability: "shallow_history" as const } : {}), ...(incomplete ? { capability: "object_unavailable" as const } : {}), dirtyNotes: dirty.count, ...(dirty.reason ? { dirtyNotesReason: dirty.reason } : {}) }),
    path, revisions: page, scanned: traversed.length, scanLimit, pageLimit, stopReason, truncated: stopReason !== "history_end", ...(continuation ? { continuation } : {}), skippedSymlink,
  };
  return fitHistory(result, transportBytes);
}

/** One historical note blob at a pinned commit, with the current reader's paging, UTF-8, symlink, size and deny rules. */
export function readRevision(request: RevisionRequest, limits: SnapshotLimits = {}): RevisionResult {
  const env = request.env ?? process.env, denyPaths = request.denyPaths ?? [];
  const transportBytes = limits.transportBytes ?? SNAPSHOT_TRANSPORT_BYTES;
  const requested = fullOid(request.revision, "revision");
  const path = resolveNote(request.vault, request.home, request.note);
  assertReadable(path, request.vault.path, denyPaths);
  const maxBytes = request.maxBytes ?? 16384, offset = request.offset;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) refuse(`max-bytes: expected integer 1..${MAX_READ_BYTES}`);
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_NOTE_BYTES)) refuse(`offset: expected integer 0..${MAX_NOTE_BYTES}`);
  if (request.section !== undefined && (!request.section.trim() || /[\r\n]/.test(request.section) || Buffer.byteLength(request.section) > 1024)) refuse("section: expected one exact H2 heading <=1024 bytes");
  const opened = openSnapshot(request.vault, env, limits);
  if (!opened.ok) {
    return { ...baseResult(request.vault, null, { complete: false, reason: opened.reason ?? opened.capability }, { capability: opened.capability, dirtyNotes: null }), path, found: false };
  }
  const snapshot = opened.snapshot, dirty = dirtyNoteCount(snapshot.git);
  const coverage = coverageOf(snapshot);
  const base = { ...baseResult(request.vault, snapshot.head, coverage, { ...(snapshot.shallow ? { capability: "shallow_history" as const } : {}), dirtyNotes: dirty.count, ...(dirty.reason ? { dirtyNotesReason: dirty.reason } : {}) }),
    path, found: false, revision: requested } as RevisionResult;
  /** A pruned, shallow or missing object is a capability result, never a generic refusal and never current content. */
  const unavailable = (): RevisionResult => ({ ...base, found: false,
    coverage: { complete: false, reason: "object_unavailable" }, capability: "object_unavailable" });
  if (!objectAvailable(snapshot.git, `${requested}^{commit}`)) return unavailable();
  const commit = commitObject(snapshot.git, requested, "revision");
  reachable(snapshot.git, commit, snapshot.head);
  const common: RevisionResult = { ...base, revision: commit };
  const tree = text(snapshot.git(["ls-tree", "-z", commit, "--", path], { maxBuffer: 8192 }).stdout).split("\0").filter(Boolean);
  if (!tree.length) return common;
  const [meta, entryPath] = tree[0]!.split("\t");
  if (entryPath !== path) refuse("revision: Git reported another path than the one requested; nothing read", "V09");
  const [mode, type, blob] = (meta ?? "").split(" ");
  if (type !== "blob") refuse("revision: the path is not a file at this revision; pick another revision from `vmem history <vault> <note>`", "V04");
  if (mode === "120000") refuse("revision: the path is a symlink at this revision; symlinked blobs are refused because a link can leave the vault. Pick another revision from `vmem history <vault> <note>`", "V06");
  if (!/^100[0-7]{3}$/.test(mode ?? "") || !blob || !FULL_OID.test(blob)) refuse("revision: the path is not a regular file at this revision; pick another revision from `vmem history <vault> <note>`", "V04");
  if (!objectAvailable(snapshot.git, blob)) return unavailable();
  const size = Number(text(snapshot.git(["cat-file", "-s", blob]).stdout).trim());
  if (!Number.isSafeInteger(size) || size < 0) return unavailable();
  if (size > MAX_NOTE_BYTES) refuse(`revision: the historical note is ${size} bytes, over the ${MAX_NOTE_BYTES}-byte read bound; read it outside vmem or split it`, "V09");
  const raw = snapshot.git(["cat-file", "blob", blob], { maxBuffer: size + 1 }).stdout;
  if (raw.length !== size) refuse("revision: the blob changed while it was read; retry", "V09");
  const source = raw.toString("utf8");
  if (!Buffer.from(source).equals(raw)) refuse("revision: the historical blob is not valid UTF-8 text; vmem reads text notes only. Read that blob with `git cat-file blob` outside vmem", "V01");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const start = offset ?? 0;
  let page: ReturnType<typeof readPage>, headings: RevisionResult["headings"], headingsTruncated: boolean | undefined;
  if (request.section !== undefined) {
    const body = parseFrontmatter(source).body, sections = h2Sections(body);
    const found = sections.filter(item => item.name === request.section);
    if (found.length !== 1) refuse(found.length ? "section: ambiguous H2 heading" : "section: unknown H2 heading");
    const selected = Buffer.from(body.slice(found[0]!.start, found[0]!.end));
    page = readPage(selected.subarray(start, start + maxBytes + 4), maxBytes, start, selected.length);
  } else {
    page = readPage(raw.subarray(start, start + maxBytes + 4), maxBytes, start, raw.length);
  }
  if (page.truncated) {
    // The same bounded heading list the current reader reports, so a historical page pages the same way.
    const metadata = headingMetadata(h2Sections(parseFrontmatter(source).body));
    headings = metadata.headings;
    headingsTruncated = metadata.headingsTruncated;
  }
  const result: RevisionResult = { ...common, found: true, revision: commit, blob, sha256, bytes: size, content: page.content,
    truncated: page.truncated, ...(request.section !== undefined ? { section: request.section } : {}), ...(offset !== undefined ? { offset } : {}),
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), ...(headings ? { headings } : {}), ...(headingsTruncated ? { headingsTruncated } : {}) };
  return fitRevision(result, transportBytes);
}

interface RawChange { oldMode: string; mode: string; oldBlob: string; blob: string; status: string; path: string }
function parseDiffRaw(output: string): RawChange[] {
  const tokens = output.split("\0"), changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith(":")) continue;
    const parts = token.slice(1).split(" "), path = tokens[++i] ?? "";
    changes.push({ oldMode: parts[0] ?? "", mode: parts[1] ?? "", oldBlob: parts[2] ?? "", blob: parts[3] ?? "", status: parts[4] ?? "", path });
  }
  return changes;
}

/** Notes-only tree comparison between two pinned commits: blob hashes and status, never a content diff. */
export function readChanges(request: ChangesRequest, limits: SnapshotLimits = {}): ChangesResult {
  const env = request.env ?? process.env, denyPaths = request.denyPaths ?? [];
  const pageLimit = limits.pageLimit ?? CHANGES_PAGE_LIMIT;
  const transportBytes = limits.transportBytes ?? SNAPSHOT_TRANSPORT_BYTES;
  const from = fullOid(request.from, "from"), to = fullOid(request.to, "to");
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > pageLimit)) refuse(`limit: expected integer 1..${pageLimit}`);
  const opened = openSnapshot(request.vault, env, limits);
  if (!opened.ok) {
    return { ...baseResult(request.vault, null, { complete: false, reason: opened.reason ?? opened.capability }, { capability: opened.capability, dirtyNotes: null }), from, to, changed: [], total: 0, truncated: false, skippedDenied: 0, skippedSymlink: 0 };
  }
  const snapshot = opened.snapshot, dirty = dirtyNoteCount(snapshot.git);
  const fromCommit = commitObject(snapshot.git, from, "from"), toCommit = commitObject(snapshot.git, to, "to");
  reachable(snapshot.git, fromCommit, snapshot.head);
  reachable(snapshot.git, toCommit, snapshot.head);
  const out = snapshot.git(["diff-tree", "-r", "--no-renames", "--raw", "-z", "--no-abbrev", "--no-textconv", "--no-ext-diff", fromCommit, toCommit, "--", "notes"], { maxBuffer: DIFF_BUFFER_BYTES });
  let skippedDenied = 0, skippedSymlink = 0;
  const changed: ChangedNote[] = [];
  for (const record of parseDiffRaw(text(out.stdout))) {
    const path = notesPath(record.path);
    if (!path) continue;
    // A symlink or submodule on either side is not a note; its path or object id is never reported.
    const regular = (mode: string) => mode === "000000" || /^100[0-7]{3}$/.test(mode);
    if (!regular(record.oldMode) || !regular(record.mode)) { skippedSymlink++; continue; }
    if (isDenied(join(snapshot.root, path), [...denyPaths])) { skippedDenied++; continue; }
    const status = record.status.slice(0, 1);
    if (!["A", "M", "D", "T"].includes(status)) continue;
    changed.push({ path, status: status as ChangeStatus,
      before: status === "A" || ZERO_OID.test(record.oldBlob) ? null : record.oldBlob,
      after: status === "D" || ZERO_OID.test(record.blob) ? null : record.blob });
  }
  let remaining = changed;
  if (request.cursor !== undefined) {
    const cursor = decodeCursor(request.cursor);
    if (cursor.kind !== "changes") refuse("cursor: belongs to a history page; restart without --cursor");
    if (cursor.from !== fromCommit || cursor.to !== toCommit) refuse("cursor: belongs to another revision pair; restart without --cursor");
    const at = changed.findIndex(item => item.path === cursor.after);
    if (at < 0) refuse("cursor: no longer matches these snapshots; restart without --cursor");
    remaining = changed.slice(at + 1);
  }
  const page = remaining.slice(0, Math.min(request.limit ?? pageLimit, pageLimit));
  const continuation = remaining.length > page.length && page.length
    ? encodeCursor({ v: 1, kind: "changes", from: fromCommit, to: toCommit, after: page.at(-1)!.path }) : undefined;
  const result: ChangesResult = {
    ...baseResult(request.vault, snapshot.head, coverageOf(snapshot), { ...(snapshot.shallow ? { capability: "shallow_history" as const } : {}), dirtyNotes: dirty.count, ...(dirty.reason ? { dirtyNotesReason: dirty.reason } : {}) }),
    from: fromCommit, to: toCommit, changed: page, total: changed.length, truncated: remaining.length > page.length, ...(continuation ? { continuation } : {}), skippedDenied, skippedSymlink,
  };
  return fitChanges(result, transportBytes);
}

const command = (...words: string[]) => ["vmem", ...words].map(shellWord).join(" ");
function basisRows(result: SnapshotBase): [string, unknown][] {
  return [["Basis", result.basis], ["Head", result.head?.slice(0, 12)], ["Dirty notes", result.dirtyNotes === null ? result.dirtyNotesReason ?? "unavailable" : result.dirtyNotes], ["Coverage", result.coverage.complete ? "complete" : `incomplete: ${result.coverage.reason ?? "unknown"}`]];
}
export function historyText(result: HistoryResult, o: TextOptions, c: { vault: string; note: string; limit?: number; cursor?: string }): string {
  const out = new Report(o.columns, o.ascii).header("vmem", "history");
  if (result.stopReason === "scan_limit" || result.stopReason === "transport_limit") out.section("Coverage").bullet("warn", result.stopReason === "scan_limit" ? `stopped after the ${result.scanLimit}-commit scan limit; continue from the cursor` : "result reached the 48 KiB transport bound; page with a smaller --limit");
  out.section("History").kv([["Vault", c.vault], ["Path", result.path], ...basisRows(result), ["Scanned commits", result.scanned], ["Page limit", result.pageLimit], ["Skipped symlinks", result.skippedSymlink]]);
  if (!result.revisions.length) out.note(result.capability ? `no snapshot history: ${result.capability}` : `no recorded revisions of ${result.path} on the first-parent history`);
  else out.table(["Revision", "Blob", "Bytes", "Committed (Git metadata)"], result.revisions.map(item => [item.revision.slice(0,12), item.blob.slice(0,12), String(item.bytes), item.committedAt]));
  if (result.continuation) out.next(command("history", c.vault, result.path, ...(c.limit !== undefined ? ["--limit", String(c.limit)] : []), "--cursor", result.continuation));
  return out.render(o.color).join("\n");
}
export function revisionText(result: RevisionResult, o: TextOptions, c: { vault: string; note: string; revision: string; maxBytes?: number }): string {
  const where = result.revision ? result.revision.slice(0, 12) : c.revision.slice(0, 12), out = new Report(o.columns, o.ascii).header("vmem", "show");
  out.section("Revision").kv([["Vault", c.vault], ["Path", result.path], ["Revision", result.revision ?? c.revision], ["Blob", result.blob], ["SHA256", result.sha256?.slice(0,12)], ["Bytes", result.bytes], ["Offset", result.offset], ...basisRows(result)]);
  if (!result.found) { out.note(result.capability ? `no historical content: ${result.capability}` : `the note did not exist at ${where}`); return out.render(o.color).join("\n"); }
  out.section("Content"); const body = stripTerminal(result.content ?? "").replace(/\n+$/, ""), head = out.render(o.color).join("\n");
  if (!result.truncated) return `${head}\n${body}`;
  const tail = new Report(o.columns, o.ascii).section("Continuation").bullet("warn", result.transportLimited ? "truncated at the 48 KiB transport bound" : "truncated");
  if (result.nextOffset !== undefined) tail.next(command("show", c.vault, c.note, "--revision", result.revision ?? c.revision, ...(result.section ? ["--section", result.section] : []), ...(c.maxBytes !== undefined ? ["--max-bytes", String(c.maxBytes)] : []), "--offset", String(result.nextOffset)));
  if (result.headings?.length) { tail.section("H2 headings"); for (const heading of result.headings) tail.bullet("absent", heading); if (result.headingsTruncated) tail.note("more headings"); }
  return `${head}\n${body}\n\n${tail.render(o.color).join("\n")}`;
}
export function changesText(result: ChangesResult, o: TextOptions, c: { vault: string; from: string; to: string; limit?: number }): string {
  const out = new Report(o.columns, o.ascii).header("vmem", "changes");
  if (result.skippedDenied || result.skippedSymlink) { out.section("Coverage"); if (result.skippedDenied) out.bullet("warn", `${plural(result.skippedDenied, "denied path")} left out by current policy`); if (result.skippedSymlink) out.bullet("warn", `${plural(result.skippedSymlink, "symlinked or non-file entry")} left out`); }
  out.section("Changes").kv([["Vault", c.vault], ["From", result.from.slice(0,12)], ["To", result.to.slice(0,12)], ...basisRows(result), ["Total changes", result.total]]);
  if (!result.changed.length) out.note(`no note changes between ${result.from.slice(0,12)} and ${result.to.slice(0,12)}`);
  else out.table(["ST", "Path", "Before", "After"], result.changed.map(item => [item.status, item.path, item.before?.slice(0,12) ?? "", item.after?.slice(0,12) ?? ""]));
  if (result.continuation) out.next(command("changes", c.vault, "--from", result.from, "--to", result.to, ...(c.limit !== undefined ? ["--limit", String(c.limit)] : []), "--cursor", result.continuation));
  return out.render(o.color).join("\n");
}
