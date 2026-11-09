import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SpecSourceSpec, VmemConfig } from "./config.ts";
import { emitFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import { AGENT_MARKERS } from "./log-format.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { discoverSpecs, resolveSpecWorktree, type SpecCandidate, type SpecDocument, type SpecSnapshot } from "./spec-source.ts";
import { introducedSpecErrors, type SpecValidationIssue } from "./spec-validate.ts";
import { MAX_NOTE_BYTES } from "./vault-index.ts";
import { screenContent, screenMetadata } from "./write-validation.ts";
import { specGit } from "./spec-git.ts";

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
export interface SpecWriteIssue { code: string; severity: "error" | "warning"; message: string; path?: string; target?: string; originalTarget?: string; field?: string }
export interface SpecWriteResult {
  ok: boolean; changed: boolean; actor: "agent" | "person"; source?: string; worktree?: string; id?: string; path?: string; sha256?: string; issues: SpecWriteIssue[];
}
export interface SpecWriteOptions { env?: NodeJS.ProcessEnv; channel?: "cli" | "mcp"; binding?: SpecSourceSpec }
export interface SpecMutation { path: string; before: string | null; after: string }
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

function pathParts(path: string): string[] {
  if (typeof path !== "string" || isAbsolute(path) || !path.endsWith(".md") || path.includes("\\") || /[\p{Cc}]/u.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) refuse("PATH", "spec path is not contained Markdown; use a relative .md path outside Git administrative directories", typeof path === "string" ? path : undefined);
  return path.split("/");
}

/** Read without following links or accepting a torn/oversized file. Parent paths are checked before every write stage. */
function plainPath(root: string, path: string, denyPaths: string[] = []): string {
  pathParts(path);
  let file = root;
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) refuse("PATH", "worktree root changed; restore the original plain root and retry", path);
  for (const [index, part] of path.split("/").entries()) {
    file = join(file, part); const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (index === path.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory())) refuse("PATH", "spec path has a symlink or non-plain component; restore the plain in-worktree file and retry", path);
  }
  if (!within(root, realpathSync(file)) || deniedSpecPath(file, denyPaths)) refuse("PATH", "spec path is denied or leaves the worktree; choose an allowed plain spec file", path);
  return file;
}
function readBounded(file: string, path: string): { source: string; mode: number; identity: string } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_NOTE_BYTES)) refuse("SIZE", "spec is not a bounded plain file; split it below the spec read limit and retry", path);
    const bytes = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true });
    if (named.dev !== after.dev || named.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || size !== Number(before.size)) refuse("DRIFT", "spec changed during its read; reread vmem spec get and retry with its expectedSha", path);
    const buffer = bytes.subarray(0, size), source = buffer.toString("utf8");
    if (!Buffer.from(source).equals(buffer)) refuse("ENCODING", "spec is not valid UTF-8; re-encode the file before updating", path);
    return { source, mode: Number(before.mode & 0o777n), identity: `${before.dev}:${before.ino}` };
  } finally { closeSync(fd); }
}

function readPlain(root: string, path: string, denyPaths: string[]) { return readBounded(plainPath(root, path, denyPaths), path); }

/** Missing parent directories are allowed; every existing component must be plain. Never follows a dangling link. */
function createPath(root: string, path: string, denyPaths: string[], env: NodeJS.ProcessEnv): string {
  const parts = pathParts(path);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) refuse("PATH", "worktree root changed; restore the original plain root and retry", path);
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    let stat;
    try { stat = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || index === parts.length - 1) refuse("PATH", "create requires an absent target and plain directory components; choose a new in-worktree path", path);
    if (!within(root, realpathSync(file))) refuse("PATH", "spec parent leaves the worktree; choose a contained plain path", path);
  }
  if (deniedSpecPath(file, denyPaths)) refuse("PATH", "spec path is denied; choose an allowed path", path);
  if (specGit(root, ["check-ignore", "--quiet", "--no-index", "--", path], { env, allowedExitCodes: [0, 1] }).status === 0) refuse("PATH", "spec path is git-ignored; choose a non-ignored path or adjust the ignore policy before retrying", path);
  return file;
}
function readMutation(root: string, change: SpecMutation, denyPaths: string[], env: NodeJS.ProcessEnv): { source: string | null; mode: number; identity: string | null } {
  if (change.before !== null) return readPlain(root, change.path, denyPaths);
  createPath(root, change.path, denyPaths, env);
  return { source: null, mode: 0o600, identity: null };
}
function ensureCreateParents(root: string, path: string, denyPaths: string[], env: NodeJS.ProcessEnv, owned: Map<string, string>): void {
  let parent = root;
  for (const part of pathParts(path).slice(0, -1)) {
    createPath(root, path, denyPaths, env);
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); owned.set(parent, identity(parent)); }
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
  if (change.before === null) {
    try { linkSync(temp, file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "IO";
      if (code === "EEXIST") refuse("EEXIST", "create target appeared before publication; inspect the existing file and choose an absent path before retrying", change.path);
      refuse("LINK", `create hard-link publication failed (${code}: ${error instanceof Error ? error.message : "unavailable link"}); check filesystem hard-link support and permissions, then choose a writable worktree on a filesystem supporting same-directory hard links; create never falls back to rename`, change.path);
    }
  }
  else renameSync(temp, file);
  result.changed = true; result.sha256 = hash(change.after);
  if (change.before === null) unlinkSync(temp);
}
function cleanupCreatedDirs(owned: Map<string, string>, result: SpecWriteResult): void {
  if (result.changed) return;
  for (const [dir, stamp] of [...owned].reverse()) {
    try { if (identity(dir) !== stamp) throw new Error("directory ownership changed"); rmdirSync(dir); }
    catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "owned empty parent directory cleanup failed; inspect the target's parent directories before retrying", ...(result.path ? { path: result.path } : {}) }); }
  }
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
export function attributeSpecErrors(issues: SpecValidationIssue[], path: string): SpecWriteIssue[] {
  return issues.map(issue => ({ ...issue, path, ...(issue.path !== path ? { target: issue.path, ...(issue.target !== undefined ? { originalTarget: issue.target } : {}) } : {}), message: `${issue.message}; correct the update to ${path} and retry` }));
}
function screen(after: string, source: SpecSourceSpec, config: VmemConfig, path: string): void {
  if (Buffer.byteLength(after) > MAX_NOTE_BYTES) refuse("SIZE", "updated spec exceeds the read limit; reduce its frontmatter or split the file before retrying", path);
  const vault = { ...source, kind: "personal" as const };
  const issues = [...screenContent(after, vault, config), ...screenMetadata(parseFrontmatter(after).data, { vault, config }, path)]
    .filter(issue => issue.severity === "error").map(issue => ({ ...issue, path, message: `${issue.message}; remove the content matched by ${issue.code} from ${path} and retry` }));
  if (issues.length) throw new Refusal([...new Map(issues.map(issue => [`${issue.code}:${issue.message}`, issue])).values()]);
}

interface SpecWriteGuard { config: VmemConfig; source: SpecSourceSpec; root: string; homeRoot: string; bindings: readonly (readonly [string, string])[]; path?: string }
/** Every authorization check uses the fresh registry, both at startup and immediately before publication. */
function guardSpecWrite(home: string, request: Pick<SpecUpdateRequest, "source" | "worktree">, options: SpecWriteOptions, previous?: SpecWriteGuard, prepare?: (guard: SpecWriteGuard) => string): SpecWriteGuard {
  const config = loadRegistry(home), sources = config.specs ?? [], source = request.source === undefined ? sources[0] : sources.find(value => value.id === request.source);
  const path = previous?.path, env = options.env ?? process.env, channel = options.channel ?? "cli";
  if (!source) refuse(previous ? "REGISTRY_DRIFT" : "SOURCE", "spec source is not registered; use vmem specs list and select a registered source", path);
  if (options.binding && !isDeepStrictEqual(source, options.binding)) refuse("REGISTRY_DRIFT", "spec source changed since MCP startup; restart the server and reread the spec before updating", path);
  if (previous && (!isDeepStrictEqual(source, previous.source) || !isDeepStrictEqual(config.denyPaths, previous.config.denyPaths) || !isDeepStrictEqual(config.piiPatterns, previous.config.piiPatterns))) refuse("REGISTRY_DRIFT", "spec registry or screening policy changed during the write; reread the source policy and spec before retrying", path);
  if (!["mcp", "cli"].includes(channel)) refuse("POLICY", "unknown spec write channel; use CLI or MCP", path);
  const root = resolveSpecWorktree(source, request.worktree, env), homeRoot = canonicalPath(home);
  if (deniedSpecPath(root, config.denyPaths ?? [])) refuse("PATH", "spec worktree is denied; select an allowed registered source", path);
  const roots = [root, source.path, ...config.vaults.map(value => value.path), ...sources.map(value => value.path)];
  if (roots.some(value => within(value, homeRoot))) refuse("HOME", "VMEM_HOME is inside a registered source/worktree; select a home outside repositories before writing", path);
  const bindings = [...new Set([root, source.path])].map(value => [value, identity(value)] as const);
  if (previous && (root !== previous.root || !isDeepStrictEqual(bindings, previous.bindings))) refuse("DRIFT", "spec worktree identity changed; restore the registered worktree and retry", path);
  const guard = { config, source, root, homeRoot, bindings, path };
  // Resolve the written path once so startup policy refusals retain path attribution.
  if (prepare) guard.path = prepare(guard);
  if (source.write === "none" || channel === "mcp" && source.write !== "mcp") refuse("POLICY", `spec write policy ${source.write} refuses channel ${channel}; select an allowed channel or have the owner update the source policy`, guard.path);
  return guard;
}

/** Common policy/binding/lock/CAS/validation/atomic path. Future create/delete planners can share these guards. */
export function mutateSpec(home: string, request: Pick<SpecUpdateRequest, "id" | "source" | "worktree" | "expectedSha">, plan: (snapshot: SpecSnapshot) => SpecMutation, options: SpecWriteOptions = {}): SpecWriteResult {
  const env = options.env ?? process.env, channel = options.channel ?? "cli";
  const result: SpecWriteResult = { ok: false, changed: false, actor: channel === "mcp" || AGENT_MARKERS.some(key => !!env[key]) ? "agent" : "person", id: request.id, issues: [] };
  const createdDirs = new Map<string, string>();
  let lockFd: number | undefined, lockFile: string | undefined, lockIdentity: string | undefined, temp: string | undefined, tempIdentity: string | undefined;
  try {
    let initial!: SpecSnapshot, first!: SpecMutation, commonIdentity!: string;
    const startup = guardSpecWrite(home, request, options, undefined, guard => {
      result.source = guard.source.id; result.worktree = guard.root;
      initial = discoverSpecs(guard.source, { worktree: guard.root, env }); commonIdentity = identity(initial.commonDir); first = plan(initial);
      result.path = first.path; readMutation(guard.root, first, guard.config.denyPaths ?? [], env);
      return first.path;
    });
    const { config, source, root, homeRoot } = startup;
    const assertBinding = () => {
      if (lockFile && lockIdentity !== undefined && identity(lockFile) !== lockIdentity) refuse("LOCKED", "spec mutation lock changed ownership; inspect the lock under VMEM_HOME and retry after the other writer finishes", result.path);
      guardSpecWrite(home, request, options, startup);
    };
    checkExpectedSha(first, request.expectedSha);
    screen(first.after, source, config, first.path);
    if (first.before === first.after) { assertBinding(); result.ok = true; result.sha256 = hash(first.after); return result; }
    mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
    const lockDir = join(homeRoot, "spec-mutations"); mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    if (lstatSync(lockDir).isSymbolicLink() || realpathSync(lockDir) !== lockDir) refuse("LOCKED", "spec lock directory is not plain; restore a private lock directory under VMEM_HOME and retry", first.path);
    lockFile = join(lockDir, `${hash(root)}.lock`);
    try { lockFd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      lockFile = undefined;
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") refuse("LOCKED", "spec mutation lock already exists; wait for the other mutation, or inspect the interrupted writer's owned lock under VMEM_HOME before retrying", first.path);
      refuse("IO", `spec mutation lock open failed (${writeErrorCause(error)}); check permissions and free space for the lock directory under VMEM_HOME, then retry`, first.path);
    }
    const ownedLock = fstatSync(lockFd, { bigint: true }); lockIdentity = `${ownedLock.dev}:${ownedLock.ino}`;
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: randomUUID() }) + "\n"); fsyncSync(lockFd);
    assertBinding();
    const current = discoverSpecs(source, { worktree: root, env }), change = plan(current);
    if (current.commonDir !== initial.commonDir || identity(initial.commonDir) !== commonIdentity || change.path !== first.path || change.before !== first.before) refuse("DRIFT", "spec changed since the request read; reread vmem spec get and retry with its sha256", first.path);
    const original = readMutation(root, change, config.denyPaths ?? [], env);
    if (original.source !== change.before) refuse("DRIFT", "spec changed under the mutation lock; reread vmem spec get and retry", change.path);
    const prospective = prospectiveSpecSnapshot(current, new Map([[change.path, change.after]]));
    screen(change.after, source, config, change.path);
    const introduced = introducedSpecErrors(current, prospective, { env });
    if (introduced.length) throw new Refusal(attributeSpecErrors(introduced, change.path));
    const file = prepareMutationTarget(root, change, config.denyPaths ?? [], env, createdDirs), parent = dirname(file), parentIdentity = identity(parent);
    const candidateTemp = join(parent, `.spec-${randomUUID()}.tmp`);
    const fd = openSync(candidateTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, original.mode);
    temp = candidateTemp;
    try { const stat = fstatSync(fd, { bigint: true }); tempIdentity = `${stat.dev}:${stat.ino}`; fchmodSync(fd, original.mode); writeFileSync(fd, change.after); fsyncSync(fd); } finally { closeSync(fd); }
    assertBinding();
    if (identity(parent) !== parentIdentity || !isDeepStrictEqual(discoverSpecs(source, { worktree: root, env }), current)) refuse("DRIFT", "spec tree changed while validating; reread the source tree and retry the update", change.path);
    const latest = readMutation(root, change, config.denyPaths ?? [], env), staged = readBounded(temp, change.path);
    if (latest.source !== change.before || latest.identity !== original.identity || staged.source !== change.after || staged.identity !== tempIdentity) refuse("DRIFT", "spec target or staged file changed before commit; reread the spec and retry the update", change.path);
    assertBinding();
    publishSpec(temp, file, change, result); temp = undefined;
    syncDirectory(parent); result.ok = true;
  } catch (error) {
    result.issues = error instanceof Refusal ? error.issues : [{ code: "IO", severity: "error", message: `spec write failed (${writeErrorCause(error)}); inspect the written file and source binding, check permissions and free space for the target and VMEM_HOME lock directory, repair the reported cause and retry`, ...(result.path ? { path: result.path } : {}) }];
    result.path ??= result.issues.find(issue => issue.path)?.path;
  } finally {
    if (temp) {
      try { if (identity(temp) !== tempIdentity) throw new Error("temporary ownership changed"); unlinkSync(temp); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "spec temporary cleanup could not prove owned-file removal; inspect the .spec-*.tmp file in the target directory before retrying (a replacement is preserved)", ...(result.path ? { path: result.path } : {}) }); }
    }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "spec lock descriptor close failed; inspect the write receipt and lock state before retrying", ...(result.path ? { path: result.path } : {}) }); }
      try { if (lockFile && identity(lockFile) === lockIdentity) unlinkSync(lockFile); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "spec lock cleanup failed; inspect the owned lock under VMEM_HOME before retrying", ...(result.path ? { path: result.path } : {}) }); }
    }
    cleanupCreatedDirs(createdDirs, result);
  }
  return result;
}

function updateFrontmatter(document: SpecCandidate, request: SpecUpdateRequest): string {
  const path = document.path, changes: Record<string, unknown> = {};
  const invalid = (message: string): never => refuse("INPUT", `${message}; use only the documented spec update set/unset/add/remove fields`, path);
  if (Object.keys(request).some(key => !["id", "source", "worktree", "expectedSha", "set", "unset", "add", "remove"].includes(key))) invalid("unknown update option");
  for (const field of ["set", "add", "remove"] as const) if (request[field] !== undefined && !record(request[field])) invalid(`${field} must be an object`);
  if (request.unset !== undefined && (!Array.isArray(request.unset) || request.unset.some(key => typeof key !== "string" || !(SPEC_UPDATE_OPTIONAL_FIELDS as readonly string[]).includes(key)))) invalid("unset accepts optional fields only; id, type and title are required");
  for (const [key, value] of Object.entries(request.set ?? {})) {
    if (!(SPEC_UPDATE_SCALAR_FIELDS as readonly string[]).includes(key) || typeof value !== "string" || !value.trim()) invalid("set accepts known nonempty scalar fields only; id is immutable");
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
    if (/[\r\n]/.test(request.title)) invalid("title must be a single line for the generated H1 heading");
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
  }, options);
}
const SPEC_HEADINGS: Readonly<Record<string, readonly string[]>> = {
  goal: ["Scope", "Decisions", "Success and evidence"], architecture: ["Boundaries", "Decisions"],
  module: ["Responsibility", "Interfaces", "Decisions"], submodule: ["Responsibility", "Interfaces", "Decisions"],
};
