import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SpecSourceSpec, VmemConfig } from "./config.ts";
import { emitFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import { AGENT_MARKERS } from "./log-format.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { discoverSpecs, resolveSpecWorktree, MAX_SPEC_MARKDOWN_PATHS, type SpecCandidate, type SpecDocument, type SpecSnapshot } from "./spec-source.ts";
import { introducedSpecErrors, type SpecValidationIssue } from "./spec-validate.ts";
import { MAX_NOTE_BYTES } from "./vault-index.ts";
import { screenContent, screenMetadata } from "./write-validation.ts";
import { specGit } from "./spec-git.ts";
import { buildSpecGraph, type SpecEdge, type SpecNode } from "./spec-graph.ts";

export const SPEC_UPDATE_SCALAR_FIELDS = ["title", "type", "status", "parent", "superseded-by", "verified-against"] as const;
export const SPEC_UPDATE_LIST_FIELDS = ["depends-on", "references", "implements", "covers", "tags", "paths"] as const;
export const SPEC_UPDATE_OPTIONAL_FIELDS = ["status", "parent", "superseded-by", "verified-against", ...SPEC_UPDATE_LIST_FIELDS] as const;
export interface SpecUpdateRequest {
  id: string; source?: string; worktree?: string; expectedSha?: string;
  set?: Record<string, string>; unset?: string[]; add?: Record<string, string[]>; remove?: Record<string, string[]>;
}
export interface SpecCreateRequest {
  path: string; id: string; type: string; title: string; source?: string; worktree?: string;
  status?: string; parent?: string; "superseded-by"?: string; "verified-against"?: string;
  "depends-on"?: string[]; references?: string[]; implements?: string[]; covers?: string[]; tags?: string[]; paths?: string[];
}
export interface SpecDeleteRequest { id: string; source?: string; worktree?: string; confirm?: boolean; fingerprint?: string }
export interface SpecDeleteResult extends SpecWriteResult { preview?: boolean; fingerprint?: string; backlinks?: SpecEdge[]; children?: SpecNode[] }
interface SpecDeletePreview { preview: boolean; fingerprint: string; sha256: string; backlinks: SpecEdge[]; children: SpecNode[] }
export interface SpecWriteIssue { code: string; severity: "error" | "warning"; message: string; path?: string; target?: string; originalTarget?: string; field?: string }
export interface SpecWriteResult {
  ok: boolean; changed: boolean; actor: "agent" | "person"; source?: string; worktree?: string; id?: string; path?: string; sha256?: string; issues: SpecWriteIssue[];
}
export interface SpecWriteOptions { env?: NodeJS.ProcessEnv; channel?: "cli" | "mcp"; binding?: SpecSourceSpec }
export interface SpecMutation { path: string; before: string | null; after: string | null; deletion?: SpecDeletePreview; expectedFingerprint?: string }
type SpecWriteOperation = "create" | "update" | "delete";
function retrySpecOperation(operation: SpecWriteOperation): string {
  if (operation === "delete") return "request a fresh preview with vmem spec delete, review its backlinks and children, then confirm the delete with that fingerprint";
  return operation === "create" ? "reread the source tree and retry the create" : "reread vmem spec get and retry the update with its sha256 (--expected-sha)";
}
const deletedSpecInspection = "inspect the deleted file's parent directory, and inspect the lock state under VMEM_HOME";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class Refusal extends Error {
  constructor(readonly issues: SpecWriteIssue[]) { super(issues[0]?.message ?? "spec mutation refused; inspect the write issues before retrying"); }
}
function refuse(code: string, message: string, path?: string): never { throw new Refusal([{ code, severity: "error", message, ...(path === undefined ? {} : { path }) }]); }
function writeErrorCause(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `${typeof code === "string" ? `${code}: ` : ""}${error instanceof Error ? error.message : String(error)}`;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const within = (root: string, file: string) => { const path = relative(root, file); return path === "" || !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`); };
const identity = (file: string) => { const stat = lstatSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
function deniedSpecPath(file: string, denyPaths: string[]): boolean {
  return isDenied(canonicalPath(file), denyPaths) || isDenied(file, denyPaths);
}

function pathParts(path: string, operation: SpecWriteOperation = "create"): string[] {
  if (typeof path !== "string" || isAbsolute(path) || !path.endsWith(".md") || path.includes("\\") || /[\p{Cc}]/u.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) refuse("PATH", `spec path is not contained Markdown; use a relative .md path outside Git administrative directories${operation === "delete" ? `, then ${retrySpecOperation(operation)}` : ""}`, typeof path === "string" ? path : undefined);
  return path.split("/");
}

/** Read without following links or accepting a torn/oversized file. Parent paths are checked before every write stage. */
function plainPath(root: string, path: string, denyPaths: string[] = [], operation: SpecWriteOperation = "update"): string {
  pathParts(path, operation);
  const next = operation === "delete" ? `, then ${retrySpecOperation(operation)}` : " and retry";
  let file = root;
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) refuse("PATH", `worktree root changed; restore the original plain root${next}`, path);
  for (const [index, part] of path.split("/").entries()) {
    file = join(file, part); const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (index === path.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory())) refuse("PATH", `spec path has a symlink or non-plain component; restore the plain in-worktree file${next}`, path);
  }
  if (!within(root, realpathSync(file)) || deniedSpecPath(file, denyPaths)) refuse("PATH", `spec path is denied or leaves the worktree; choose an allowed plain spec file${operation === "delete" ? next : ""}`, path);
  return file;
}
function readBounded(file: string, path: string, operation: SpecWriteOperation): { source: string; mode: number; identity: string } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_NOTE_BYTES)) refuse("SIZE", `spec ${operation} input is not a bounded plain file; ${operation === "create" ? "reduce the metadata" : "split the file below the read limit"}, then ${retrySpecOperation(operation)}`, path);
    const bytes = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true });
    if (named.dev !== after.dev || named.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || size !== Number(before.size)) refuse("DRIFT", `spec ${operation} input changed during its read; ${retrySpecOperation(operation)}`, path);
    const buffer = bytes.subarray(0, size), source = buffer.toString("utf8");
    if (!Buffer.from(source).equals(buffer)) refuse("ENCODING", `spec ${operation} input is not valid UTF-8; ${operation === "create" ? retrySpecOperation(operation) : `re-encode the file, then ${retrySpecOperation(operation)}`}`, path);
    return { source, mode: Number(before.mode & 0o777n), identity: `${before.dev}:${before.ino}` };
  } finally { closeSync(fd); }
}

function readPlain(root: string, path: string, denyPaths: string[], operation: SpecWriteOperation) { return readBounded(plainPath(root, path, denyPaths, operation), path, operation); }

/** The prospective file must belong to the same tree that discovery will scan. */
function guardCreateRepository(root: string, path: string, ancestors: string[], deepest: string, env: NodeJS.ProcessEnv): void {
  if (ancestors.length) {
    const physical = new Set(ancestors.map(ancestor => canonicalPath(join(root, ancestor))));
    // The first component covers every indexed ancestor, including missing gitlink workdirs.
    const spellings = new Set(ancestors.slice(0, 1).flatMap(ancestor => [ancestor, relative(root, canonicalPath(join(root, ancestor))).split(sep).join("/")]).flatMap(ancestor => [ancestor, ancestor.normalize("NFC"), ancestor.normalize("NFD")]));
    const entries = specGit(root, ["ls-files", "--stage", "-z", "--", ...[...spellings].map(ancestor => `:(icase,literal)${ancestor}`)], { env, maxBuffer: 16 * 1024 * 1024 }).stdout.toString("utf8").split("\0");
    for (const entry of entries) {
      const tab = entry.indexOf("\t");
      if (entry.startsWith("160000 ") && tab >= 0 && physical.has(canonicalPath(join(root, entry.slice(tab + 1))))) refuse("PATH", "spec path crosses a submodule gitlink; create the spec in that repository's own source", path);
    }
  }
  const top = specGit(canonicalPath(deepest), ["rev-parse", "--show-toplevel"], { env }).stdout.toString("utf8").replace(/\r?\n$/, "");
  if (canonicalPath(top) !== root) refuse("PATH", "spec path crosses into a nested repository; create the spec in that repository's own source", path);
}

/** Missing parent directories are allowed; every existing component must be plain. Never follows a dangling link. */
function createPath(root: string, path: string, denyPaths: string[], env: NodeJS.ProcessEnv): string {
  const parts = pathParts(path);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) refuse("PATH", "worktree root changed; restore the original plain root and retry", path);
  let file = root, deepest = root;
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    let stat;
    try { stat = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || index === parts.length - 1) refuse("PATH", "create requires an absent target and plain directory components; choose a new in-worktree path", path);
    if (!within(root, realpathSync(file))) refuse("PATH", "spec parent leaves the worktree; choose a contained plain path", path);
    deepest = file;
  }
  if (deniedSpecPath(file, denyPaths)) refuse("PATH", "spec create path is denied; choose an allowed path and retry the create", path);
  guardCreateRepository(root, path, parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")), deepest, env);
  if (specGit(root, ["check-ignore", "--quiet", "--no-index", "--", `./${path}`], { env, allowedExitCodes: [0, 1] }).status === 0) refuse("PATH", "spec path is git-ignored; choose a non-ignored path or adjust the ignore policy before retrying the create", path);
  return file;
}
function readMutation(root: string, change: SpecMutation, denyPaths: string[], env: NodeJS.ProcessEnv, operation: SpecWriteOperation): { source: string | null; mode: number; identity: string | null } {
  if (change.before !== null) return readPlain(root, change.path, denyPaths, operation);
  createPath(root, change.path, denyPaths, env);
  return { source: null, mode: 0o666 & ~process.umask(), identity: null };
}
function ensureCreateParents(root: string, path: string, denyPaths: string[], env: NodeJS.ProcessEnv, owned: Map<string, string>): void {
  let parent = root;
  for (const part of pathParts(path).slice(0, -1)) {
    createPath(root, path, denyPaths, env);
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o777 & ~process.umask() }); owned.set(parent, identity(parent)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  createPath(root, path, denyPaths, env);
}
function prepareMutationTarget(root: string, change: SpecMutation, denyPaths: string[], env: NodeJS.ProcessEnv, owned: Map<string, string>): string {
  if (change.before !== null) return plainPath(root, change.path, denyPaths);
  ensureCreateParents(root, change.path, denyPaths, env, owned);
  return createPath(root, change.path, denyPaths, env);
}
function checkExpectedSha(change: SpecMutation, expectedSha: string | undefined): void {
  if (expectedSha !== undefined && (change.before === null || !/^[a-f0-9]{64}$/.test(expectedSha) || hash(change.before) !== expectedSha)) refuse("EXPECTED_SHA", "expectedSha does not match the spec; reread vmem spec get and retry with its sha256", change.path);
}
/** A new target is published without replacement; an update replaces its checked original. */
function publishSpec(temp: string, file: string, change: SpecMutation, result: SpecWriteResult): void {
  if (change.after === null) throw new Error("deletion cannot publish a temporary file");
  if (change.before === null) {
    try { linkSync(temp, file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") refuse("EEXIST", "create target appeared before publication; inspect the existing file and choose an absent path before retrying", change.path);
      refuse("LINK", `create hard-link publication failed (${writeErrorCause(error)}); check filesystem hard-link support and permissions and free space, then choose a writable worktree on a filesystem supporting same-directory hard links; create never falls back to rename`, change.path);
    }
  }
  else renameSync(temp, file);
  result.changed = true; result.sha256 = hash(change.after);
  if (change.before === null) unlinkSync(temp);
}
function createdDirectoryCleanupIssue(error: unknown, race: boolean, directory: string): SpecWriteIssue {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY") return { code: "CLEANUP", severity: "warning", message: `created parent directory was kept (${directory}, ENOTEMPTY) because it now contains another file or directory; ${race ? "this is expected after a refused create race; " : ""}inspect the preserved contents and choose an absent target before retrying the create` };
  return { code: "CLEANUP", severity: "error", message: `owned parent directory cleanup failed for ${directory} (${writeErrorCause(error)}); inspect its ownership and access, preserve unrelated contents and repair the reported cause before retrying the create` };
}
function cleanupCreatedDirs(owned: Map<string, string>, result: SpecWriteResult): void {
  if (result.changed) return;
  const race = result.issues.some(issue => issue.code === "EEXIST");
  for (const [dir, stamp] of [...owned].reverse()) {
    try { if (identity(dir) !== stamp) throw new Error("directory ownership changed"); rmdirSync(dir); }
    catch (error) {
      const item = createdDirectoryCleanupIssue(error, race, dir);
      if (item.severity === "error") result.ok = false;
      result.issues.push({ ...item, ...(result.path ? { path: result.path } : {}) });
    }
  }
}
function syncCreatedParents(owned: ReadonlyMap<string, string>): void {
  for (const dir of [...owned.keys()].reverse()) syncDirectory(dirname(dir));
}

/** Pure prospective tree, shared by frontmatter update and future create/delete operations. No prospective file is read from disk. */
export function prospectiveSpecSnapshot(current: SpecSnapshot, edits: ReadonlyMap<string, string | null>): SpecSnapshot {
  const byPath = new Map((current.candidates ?? current.specs).map(candidate => [candidate.path, candidate]));
  for (const [path, source] of edits) {
    if (source === null) { byPath.delete(path); continue; }
    const document = parseFrontmatter(source);
    if (basename(path) !== "SPEC.md" && !Object.hasOwn(document.data, "id") && !Object.hasOwn(document.data, "type")) byPath.delete(path);
    else byPath.set(path, { path, hash: hash(source), source, frontmatter: document.data, body: document.body });
  }
  const candidates = [...byPath.values()].sort((a, b) => compare(a.path.normalize("NFC"), b.path.normalize("NFC")) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const specs: SpecDocument[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    const { id, type } = candidate.frontmatter;
    if (typeof id === "string" && id.trim() && typeof type === "string" && type.trim() && !seen.has(id)) { specs.push({ ...candidate, id }); seen.add(id); }
  }
  // The validation API recomputes id/shape/duplicate errors from complete candidates.
  const diagnostics = current.diagnostics.filter(item => !edits.has(item.path) && item.code !== "duplicate_id");
  return { ...current, candidates, specs, diagnostics };
}
/** Validation can blame a related file (for example a later duplicate). The mutation receipt always names the written file. */
export function attributeSpecErrors(issues: SpecValidationIssue[], path: string, operation: SpecWriteOperation = "update"): SpecWriteIssue[] {
  const correction = operation === "delete" ? `repair the source tree error before deleting ${path}` : `correct the ${operation} metadata for ${path}`;
  return issues.map(issue => ({ ...issue, path, ...(issue.path !== path ? { target: issue.path, ...(issue.target !== undefined ? { originalTarget: issue.target } : {}) } : {}), message: `${issue.message}; ${correction}; ${retrySpecOperation(operation)}` }));
}
function screen(after: string, source: SpecSourceSpec, config: VmemConfig, path: string, operation: SpecWriteOperation): void {
  if (Buffer.byteLength(after) > MAX_NOTE_BYTES) refuse("SIZE", `spec ${operation} exceeds the read limit; ${operation === "create" ? "reduce the metadata" : "reduce its frontmatter or split the file"} before retrying the ${operation}`, path);
  const vault = { ...source, kind: "personal" as const };
  const issues = [...screenContent(after, vault, config), ...screenMetadata(parseFrontmatter(after).data, { vault, config }, path)]
    .filter(issue => issue.severity === "error").map(issue => ({ ...issue, path, message: `${issue.message}; remove the content matched by ${issue.code} from ${path} and retry the ${operation}` }));
  if (issues.length) throw new Refusal([...new Map(issues.map(issue => [`${issue.code}:${issue.message}`, issue])).values()]);
}
function screenMutation(change: SpecMutation, source: SpecSourceSpec, config: VmemConfig, operation: SpecWriteOperation): void {
  if (change.after !== null) screen(change.after, source, config, change.path, operation);
}
function allowedDeleteLinks(snapshot: SpecSnapshot, change: SpecMutation): { path: string; field: string; target: string }[] {
  if (!change.deletion) return [];
  const paths = new Map(snapshot.specs.map(document => [document.id, document.path]));
  return (change.deletion?.backlinks ?? []).filter(edge => edge.kind !== "body_link").map(edge => ({ path: paths.get(edge.source)!, field: edge.kind, target: edge.target }));
}
function checkDeletionConfirmation(change: SpecMutation): void {
  if (change.deletion?.preview === false && change.expectedFingerprint !== change.deletion.fingerprint) refuse("FINGERPRINT", "delete preview is missing or stale; request a fresh preview and acknowledge its listed backlinks and children before confirming", change.path);
}

interface SpecWriteGuard { config: VmemConfig; source: SpecSourceSpec; root: string; homeRoot: string; bindings: readonly (readonly [string, string])[]; path?: string }
/** Every authorization check uses the fresh registry, both at startup and immediately before publication. */
function guardSpecWrite(home: string, request: Pick<SpecUpdateRequest, "source" | "worktree">, options: SpecWriteOptions & { operation: SpecWriteOperation }, previous?: SpecWriteGuard, prepare?: (guard: SpecWriteGuard) => string): SpecWriteGuard {
  const config = loadRegistry(home), sources = config.specs ?? [], source = request.source === undefined ? sources[0] : sources.find(value => value.id === request.source);
  const path = previous?.path, env = options.env ?? process.env, channel = options.channel ?? "cli";
  if (!source) refuse(previous ? "REGISTRY_DRIFT" : "SOURCE", `spec source is not registered; use vmem specs list and select a registered source, then ${retrySpecOperation(options.operation)}`, path);
  if (options.binding && !isDeepStrictEqual(source, options.binding)) refuse("REGISTRY_DRIFT", `spec ${options.operation} source changed since MCP startup; restart the server, then ${retrySpecOperation(options.operation)}`, path);
  if (previous && (!isDeepStrictEqual(source, previous.source) || !isDeepStrictEqual(config.denyPaths, previous.config.denyPaths) || !isDeepStrictEqual(config.piiPatterns, previous.config.piiPatterns))) refuse("REGISTRY_DRIFT", `spec registry or screening policy changed during the ${options.operation}; reread the source policy, then ${retrySpecOperation(options.operation)}`, path);
  if (!["mcp", "cli"].includes(channel)) refuse("POLICY", "unknown spec write channel; use CLI or MCP", path);
  const root = resolveSpecWorktree(source, request.worktree, env), homeRoot = canonicalPath(home);
  if (deniedSpecPath(root, config.denyPaths ?? [])) refuse("PATH", `spec worktree is denied; select an allowed registered source, then ${retrySpecOperation(options.operation)}`, path);
  const roots = [root, source.path, ...config.vaults.map(value => value.path), ...sources.map(value => value.path)];
  if (roots.some(value => within(value, homeRoot))) refuse("HOME", `VMEM_HOME is inside a registered source/worktree; select a home outside repositories, then ${retrySpecOperation(options.operation)}`, path);
  const bindings = [...new Set([root, source.path])].map(value => [value, identity(value)] as const);
  if (previous && (root !== previous.root || !isDeepStrictEqual(bindings, previous.bindings))) refuse("DRIFT", `spec worktree identity changed; restore the registered worktree, then ${retrySpecOperation(options.operation)}`, path);
  const guard = { config, source, root, homeRoot, bindings, path };
  // Resolve the written path once so startup policy refusals retain path attribution.
  if (prepare) guard.path = prepare(guard);
  if (source.write === "none" || channel === "mcp" && source.write !== "mcp") refuse("POLICY", `spec write policy ${source.write} refuses channel ${channel}; select an allowed channel or have the owner update the source policy, then ${retrySpecOperation(options.operation)}`, guard.path);
  return guard;
}

/** Count every Git-listed input, not only admitted spec candidates. */
function guardCreateDiscoveryBudget(snapshot: SpecSnapshot, change: SpecMutation): void {
  if (change.before !== null) return;
  const paths = snapshot.markdownPaths;
  if (!paths) refuse("LIMIT", "spec create discovery budget is unavailable; rescan the source with the current vmem install before retrying the create", change.path);
  if (!paths.includes(change.path) && paths.length >= MAX_SPEC_MARKDOWN_PATHS) refuse("LIMIT", `spec create would exceed the ${MAX_SPEC_MARKDOWN_PATHS}-Markdown discovery cap; remove or ignore Markdown files (untrack tracked exclusions with git rm --cached), then retry the create`, change.path);
}
/** Shared authorization, lock, validation and publication path for spec mutations. */
export function mutateSpec(home: string, request: Pick<SpecUpdateRequest, "id" | "source" | "worktree" | "expectedSha">, plan: (snapshot: SpecSnapshot) => SpecMutation, options: SpecWriteOptions = {}, operation: SpecWriteOperation = "update"): SpecWriteResult {
  const env = options.env ?? process.env, channel = options.channel ?? "cli";
  const context = { ...options, operation };
  const result: SpecWriteResult = { ok: false, changed: false, actor: channel === "mcp" || AGENT_MARKERS.some(key => !!env[key]) ? "agent" : "person", id: request.id, issues: [] };
  const createdDirs = new Map<string, string>();
  let lockFd: number | undefined, lockFile: string | undefined, lockIdentity: string | undefined, temp: string | undefined, tempIdentity: string | undefined;
  try {
    let initial!: SpecSnapshot, first!: SpecMutation, commonIdentity!: string;
    const startup = guardSpecWrite(home, request, context, undefined, guard => {
      result.source = guard.source.id; result.worktree = guard.root;
      initial = discoverSpecs(guard.source, { worktree: guard.root, env }); commonIdentity = identity(initial.commonDir); first = plan(initial);
      result.path = first.path; const firstRead = readMutation(guard.root, first, guard.config.denyPaths ?? [], env, operation);
      if (firstRead.source !== first.before) refuse("DRIFT", `spec ${operation} changed during its initial read; ${retrySpecOperation(operation)}`, first.path);
      return first.path;
    });
    const { config, source, root, homeRoot } = startup;
    guardCreateDiscoveryBudget(initial, first);
    const assertBinding = () => {
      if (lockFile && lockIdentity !== undefined && identity(lockFile) !== lockIdentity) refuse("LOCKED", `spec mutation lock changed ownership; inspect the lock under VMEM_HOME and wait for the other writer, then ${retrySpecOperation(operation)}`, result.path);
      guardSpecWrite(home, request, context, startup);
    };
    checkDeletionConfirmation(first);
    checkExpectedSha(first, request.expectedSha);
    screenMutation(first, source, config, operation);
    if (first.deletion) Object.assign(result, first.deletion);
    if (first.deletion?.preview) { assertBinding(); result.ok = true; return result; }
    if (first.before === first.after && first.after !== null) { assertBinding(); result.ok = true; result.sha256 = hash(first.after); return result; }
    mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
    const lockDir = join(homeRoot, "spec-mutations"); mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    if (lstatSync(lockDir).isSymbolicLink() || realpathSync(lockDir) !== lockDir) refuse("LOCKED", `spec lock directory is not plain; restore a private lock directory under VMEM_HOME, then ${retrySpecOperation(operation)}`, first.path);
    lockFile = join(lockDir, `${hash(root)}.lock`);
    try { lockFd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      lockFile = undefined;
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") refuse("LOCKED", `spec mutation lock already exists; wait for the other mutation or inspect the interrupted writer's owned lock under VMEM_HOME, then ${retrySpecOperation(operation)}`, first.path);
      refuse("IO", `spec mutation lock open failed (${writeErrorCause(error)}); check permissions and free space for the lock directory under VMEM_HOME, then ${retrySpecOperation(operation)}`, first.path);
    }
    const ownedLock = fstatSync(lockFd, { bigint: true }); lockIdentity = `${ownedLock.dev}:${ownedLock.ino}`;
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: randomUUID() }) + "\n"); fsyncSync(lockFd);
    assertBinding();
    const current = discoverSpecs(source, { worktree: root, env }), change = plan(current);
    checkDeletionConfirmation(change);
    if (current.commonDir !== initial.commonDir || identity(initial.commonDir) !== commonIdentity || change.path !== first.path || change.before !== first.before) refuse("DRIFT", `spec ${operation} changed since the request read; ${retrySpecOperation(operation)}`, first.path);
    const original = readMutation(root, change, config.denyPaths ?? [], env, operation);
    if (original.source !== change.before) refuse("DRIFT", `spec ${operation} changed under the mutation lock; ${retrySpecOperation(operation)}`, change.path);
    guardCreateDiscoveryBudget(current, change);
    const prospective = prospectiveSpecSnapshot(current, new Map([[change.path, change.after]]));
    screenMutation(change, source, config, operation);
    const introduced = introducedSpecErrors(current, prospective, { env }, allowedDeleteLinks(current, change));
    if (introduced.length) throw new Refusal(attributeSpecErrors(introduced, change.path, operation));
    if (change.after === null) {
      assertBinding();
      if (!isDeepStrictEqual(discoverSpecs(source, { worktree: root, env }), current)) refuse("DRIFT", `spec tree changed while validating deletion; ${retrySpecOperation(operation)}`, change.path);
      const latest = readMutation(root, change, config.denyPaths ?? [], env, operation);
      if (latest.source !== change.before || latest.identity !== original.identity) refuse("DRIFT", `spec changed before deletion; ${retrySpecOperation(operation)}`, change.path);
      const file = plainPath(root, change.path, config.denyPaths ?? [], operation);
      assertBinding();
      unlinkSync(file); result.changed = true; syncDirectory(dirname(file)); result.ok = true; return result;
    }
    const file = prepareMutationTarget(root, change, config.denyPaths ?? [], env, createdDirs), parent = dirname(file), parentIdentity = identity(parent);
    const candidateTemp = join(parent, `.spec-${randomUUID()}.tmp`);
    const fd = openSync(candidateTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, original.mode);
    temp = candidateTemp;
    try { const stat = fstatSync(fd, { bigint: true }); tempIdentity = `${stat.dev}:${stat.ino}`; fchmodSync(fd, original.mode); writeFileSync(fd, change.after); fsyncSync(fd); } finally { closeSync(fd); }
    assertBinding();
    if (identity(parent) !== parentIdentity || !isDeepStrictEqual(discoverSpecs(source, { worktree: root, env }), current)) refuse("DRIFT", `spec tree changed while validating the ${operation}; ${retrySpecOperation(operation)}`, change.path);
    const latest = readMutation(root, change, config.denyPaths ?? [], env, operation), staged = readBounded(temp, change.path, operation);
    if (latest.source !== change.before || latest.identity !== original.identity || staged.source !== change.after || staged.identity !== tempIdentity) refuse("DRIFT", `spec ${operation} target or staged file changed before publication; ${retrySpecOperation(operation)}`, change.path);
    assertBinding();
    publishSpec(temp, file, change, result); temp = undefined;
    syncDirectory(parent); syncCreatedParents(createdDirs); result.ok = true;
  } catch (error) {
    result.issues = error instanceof Refusal ? error.issues : [{ code: "IO", severity: "error", message: `spec ${operation} failed (${writeErrorCause(error)}); ${operation === "delete" && result.changed ? `${deletedSpecInspection}, check permissions and free space, and repair the reported cause` : `inspect the source tree and target directory, check permissions and free space for the target and VMEM_HOME lock directory, repair the reported cause, then ${retrySpecOperation(operation)}`}`, ...(result.path ? { path: result.path } : {}) }];
    result.path ??= result.issues.find(issue => issue.path)?.path;
  } finally {
    if (temp) {
      try { if (identity(temp) !== tempIdentity) throw new Error("temporary ownership changed"); unlinkSync(temp); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "spec temporary cleanup could not prove owned-file removal; inspect the .spec-*.tmp file in the target directory before retrying (a replacement is preserved)", ...(result.path ? { path: result.path } : {}) }); }
    }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: `spec lock descriptor close failed; ${operation === "delete" && result.changed ? deletedSpecInspection : "inspect the write receipt and lock state before retrying"}`, ...(result.path ? { path: result.path } : {}) }); }
      try { if (lockFile && identity(lockFile) === lockIdentity) unlinkSync(lockFile); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: `spec lock cleanup failed; ${operation === "delete" && result.changed ? deletedSpecInspection : "inspect the owned lock under VMEM_HOME before retrying"}`, ...(result.path ? { path: result.path } : {}) }); }
    }
    cleanupCreatedDirs(createdDirs, result);
  }
  return result;
}

function validSpecTitle(value: string): boolean { return !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value); }
function updateFrontmatter(document: SpecCandidate, request: SpecUpdateRequest): string {
  const path = document.path, changes: Record<string, unknown> = {};
  const invalid = (message: string): never => refuse("INPUT", `${message}; use only the documented spec update set/unset/add/remove fields`, path);
  if (Object.keys(request).some(key => !["id", "source", "worktree", "expectedSha", "set", "unset", "add", "remove"].includes(key))) invalid("unknown update option");
  for (const field of ["set", "add", "remove"] as const) if (request[field] !== undefined && !record(request[field])) invalid(`${field} must be an object`);
  if (request.unset !== undefined && (!Array.isArray(request.unset) || request.unset.some(key => typeof key !== "string" || !(SPEC_UPDATE_OPTIONAL_FIELDS as readonly string[]).includes(key)))) invalid("unset accepts optional fields only; id, type and title are required");
  for (const [key, value] of Object.entries(request.set ?? {})) {
    if (!(SPEC_UPDATE_SCALAR_FIELDS as readonly string[]).includes(key) || typeof value !== "string" || !value.trim()) invalid("set accepts known nonempty scalar fields only; id is immutable");
    if (key === "title" && !validSpecTitle(value)) invalid("title must be one line without control or line-separator characters; use plain single-line text");
    if (key === "type" && !["goal", "architecture", "module", "submodule"].includes(value) || key === "status" && !["draft", "active", "deprecated"].includes(value)) invalid("unknown type or status vocabulary");
    if (request.unset?.includes(key)) invalid("a field cannot be set and unset together");
    changes[key] = value;
  }
  for (const key of request.unset ?? []) changes[key] = undefined;
  for (const field of ["remove", "add"] as const) for (const [key, values] of Object.entries(request[field] ?? {})) {
    if (!(SPEC_UPDATE_LIST_FIELDS as readonly string[]).includes(key) || !Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())) invalid(`${field} accepts known lists of nonempty strings only`);
    if (request.unset?.includes(key)) invalid("a list cannot be unset and edited together");
    const current = Object.hasOwn(changes, key) ? changes[key] : document.frontmatter[key];
    if (current !== undefined && (!Array.isArray(current) || current.some(value => typeof value !== "string"))) invalid("existing list has the wrong shape; unset it before adding or removing entries");
    if (field === "add" && values.some(value => request.remove?.[key]?.includes(value))) invalid("a value cannot be added and removed together");
    const previous = (current ?? []) as string[];
    const next = field === "remove" ? previous.filter(value => !values.includes(value)) : [...previous, ...values.filter((value, index) => !previous.includes(value) && values.indexOf(value) === index)];
    if (current !== undefined || next.length) changes[key] = next;
  }
  try { return emitFrontmatter(parseFrontmatter(document.source), changes); }
  catch (error) { refuse("FRONTMATTER", `frontmatter cannot be edited losslessly (${writeErrorCause(error)}); repair its block mapping and retry`, path); }
}
export function updateSpec(home: string, request: SpecUpdateRequest, options: SpecWriteOptions = {}): SpecWriteResult {
  return mutateSpec(home, request, snapshot => {
    let document: SpecCandidate | undefined = snapshot.specs.find(candidate => candidate.id === request.id);
    if (!document) {
      const candidates = (snapshot.candidates ?? []).filter(candidate => candidate.frontmatter.id === request.id);
      if (candidates.length > 1) refuse("AMBIGUOUS", "multiple candidates share this id and none is an admitted spec; make the ids unique with an editor before retrying");
      document = candidates[0];
    }
    if (!document) refuse("TARGET", "spec id was not found; choose an id from vmem spec grep in the selected source");
    return { path: document.path, before: document.source, after: updateFrontmatter(document, request) };
  }, options);
}

/** Create structural prose only; body editing remains with the caller's normal file tools. */
export function createSpec(home: string, request: SpecCreateRequest, options: SpecWriteOptions = {}): SpecWriteResult {
  return mutateSpec(home, request, () => {
    const fields = ["id", "type", "title", "status", "parent", "superseded-by", "depends-on", "references", "implements", "covers", "tags", "paths", "verified-against"] as const;
    const invalid = (message: string): never => refuse("INPUT", `${message}; supply the documented spec create metadata fields`, request.path);
    if (Object.keys(request).some(key => !["path", "source", "worktree", ...fields].includes(key))) invalid("unknown create option");
    for (const field of ["path", "id", "type", "title"] as const) if (typeof request[field] !== "string" || !request[field].trim()) invalid(`${field} must be a nonempty string`);
    if (!Object.hasOwn(SPEC_HEADINGS, request.type)) invalid("unknown type vocabulary");
    if (request.status !== undefined && !["draft", "active", "deprecated"].includes(request.status)) invalid("unknown status vocabulary");
    if (!validSpecTitle(request.title)) invalid("title must be one line without control or line-separator characters; use plain single-line text");
    const data: Record<string, unknown> = {};
    for (const field of fields) {
      const value = field === "status" ? request.status ?? "draft" : request[field];
      if (value === undefined) continue;
      if ((SPEC_UPDATE_LIST_FIELDS as readonly string[]).includes(field)) {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) invalid(`${field} must be a list of nonempty strings`);
      } else if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a nonempty string`);
      data[field] = value;
    }
    const body = `# ${request.title}\n\n` + SPEC_HEADINGS[request.type]!.map(heading => `## ${heading}\n\n`).join("");
    return { path: request.path, before: null, after: emitFrontmatter(parseFrontmatter(body), data) };
  }, options, "create");
}
const SPEC_HEADINGS: Readonly<Record<string, readonly string[]>> = {
  goal: ["Scope", "Decisions", "Success and evidence"], architecture: ["Boundaries", "Decisions"],
  module: ["Responsibility", "Interfaces", "Decisions"], submodule: ["Responsibility", "Interfaces", "Decisions"],
};

/** Complete acknowledgements, not a paged read: oversize previews refuse rather than omit a backlink. */
function deletionPreview(snapshot: SpecSnapshot, document: SpecCandidate, preview: boolean): SpecDeletePreview {
  const graph = buildSpecGraph(snapshot), id = String(document.frontmatter.id);
  const backlinks = graph.edges.filter(edge => edge.target === id).sort((a, b) => compare(a.source, b.source) || compare(a.kind, b.kind) || compare(a.target, b.target));
  const childIds = new Set(backlinks.filter(edge => edge.kind === "parent").map(edge => edge.source));
  const children = graph.nodes.filter(node => childIds.has(node.id)).sort((a, b) => compare(a.id, b.id) || compare(a.path, b.path));
  const sha256 = hash(document.source), fingerprint = hash(JSON.stringify({ worktree: snapshot.root, path: document.path, sha256, backlinks, children }));
  const acknowledgement = { fingerprint, sha256, backlinks, children };
  if (Buffer.byteLength(JSON.stringify(acknowledgement)) > 224 * 1024) refuse("LIMIT", "complete delete acknowledgement exceeds the response budget; repair or remove backlinks before requesting a fresh preview", document.path);
  return { preview, ...acknowledgement };
}
export function deleteSpec(home: string, request: SpecDeleteRequest, options: SpecWriteOptions = {}): SpecDeleteResult {
  return mutateSpec(home, request, snapshot => {
    if (Object.keys(request).some(key => !["id", "source", "worktree", "confirm", "fingerprint"].includes(key)) || typeof request.id !== "string" || !request.id.trim() || request.confirm !== undefined && typeof request.confirm !== "boolean") refuse("INPUT", "invalid spec delete request; use a spec id, optional source/worktree and boolean confirm with a fresh preview fingerprint");
    if (request.fingerprint !== undefined && (typeof request.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(request.fingerprint))) refuse("FINGERPRINT", "invalid delete fingerprint; request a fresh delete preview before confirming");
    const document = snapshot.specs.find(candidate => candidate.id === request.id);
    if (!document) refuse("TARGET", "spec delete id was not found; choose an id from vmem spec grep in the selected source, then request a fresh preview with vmem spec delete");
    const deletion = deletionPreview(snapshot, document, request.confirm !== true);
    return { path: document.path, before: document.source, after: null, deletion, expectedFingerprint: request.fingerprint };
  }, options, "delete");
}
