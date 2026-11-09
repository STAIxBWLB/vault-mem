import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export const SPEC_UPDATE_SCALAR_FIELDS = ["title", "type", "status", "parent", "superseded-by", "verified-against"] as const;
export const SPEC_UPDATE_LIST_FIELDS = ["depends-on", "references", "implements", "covers", "tags", "paths"] as const;
export const SPEC_UPDATE_OPTIONAL_FIELDS = ["status", "parent", "superseded-by", "verified-against", ...SPEC_UPDATE_LIST_FIELDS] as const;
export interface SpecUpdateRequest {
  id: string; source?: string; worktree?: string; expectedSha?: string;
  set?: Record<string, string>; unset?: string[]; add?: Record<string, string[]>; remove?: Record<string, string[]>;
}
export interface SpecWriteIssue { code: string; severity: "error" | "warning"; message: string; path?: string; target?: string; originalTarget?: string; field?: string }
export interface SpecWriteResult {
  ok: boolean; changed: boolean; actor: "agent" | "person"; source?: string; worktree?: string; id?: string; path?: string; sha256?: string; issues: SpecWriteIssue[];
}
export interface SpecWriteOptions { env?: NodeJS.ProcessEnv; channel?: "cli" | "mcp"; binding?: SpecSourceSpec }
export interface SpecMutation { path: string; before: string; after: string }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class Refusal extends Error {
  constructor(readonly issues: SpecWriteIssue[]) { super(issues[0]?.message ?? "spec mutation refused; inspect the write issues before retrying"); }
}
function refuse(code: string, message: string, path?: string): never { throw new Refusal([{ code, severity: "error", message, ...(path === undefined ? {} : { path }) }]); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const within = (root: string, file: string) => { const path = relative(root, file); return path === "" || !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`); };
const identity = (file: string) => { const stat = lstatSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };

/** Read without following links or accepting a torn/oversized file. Parent paths are checked before every write stage. */
function plainPath(root: string, path: string, denyPaths: string[] = []): string {
  if (isAbsolute(path) || !path.endsWith(".md") || path.includes("\\") || /[\p{Cc}]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) refuse("PATH", "spec path is not contained Markdown; use a discovered plain .md file", path);
  let file = root;
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) refuse("PATH", "worktree root changed; restore the original plain root and retry", path);
  for (const [index, part] of path.split("/").entries()) {
    file = join(file, part); const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (index === path.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory())) refuse("PATH", "spec path has a symlink or non-plain component; restore the plain in-worktree file and retry", path);
  }
  if (!within(root, realpathSync(file)) || isDenied(file, denyPaths)) refuse("PATH", "spec path is denied or leaves the worktree; choose an allowed plain spec file", path);
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

/** Common policy/binding/lock/CAS/validation/atomic path. Future create/delete planners can share these guards. */
export function mutateSpec(home: string, request: Pick<SpecUpdateRequest, "id" | "source" | "worktree" | "expectedSha">, plan: (snapshot: SpecSnapshot) => SpecMutation, options: SpecWriteOptions = {}): SpecWriteResult {
  const env = options.env ?? process.env, channel = options.channel ?? "cli";
  const result: SpecWriteResult = { ok: false, changed: false, actor: channel === "mcp" || AGENT_MARKERS.some(key => !!env[key]) ? "agent" : "person", id: request.id, issues: [] };
  let lockFd: number | undefined, lockFile: string | undefined, lockIdentity: string | undefined, temp: string | undefined, tempIdentity: string | undefined;
  try {
    const config = loadRegistry(home), sources = config.specs ?? [], source = request.source === undefined ? sources[0] : sources.find(value => value.id === request.source);
    if (!source) refuse("SOURCE", "spec source is not registered; use vmem specs list and select a registered source");
    result.source = source.id;
    if (options.binding && !isDeepStrictEqual(source, options.binding)) refuse("REGISTRY_DRIFT", "spec source changed since MCP startup; restart the server and reread the spec before updating");
    if (!["mcp", "cli"].includes(channel)) refuse("POLICY", "unknown spec write channel; use CLI or MCP");
    const root = resolveSpecWorktree(source, request.worktree, env); result.worktree = root;
    if (isDenied(root, config.denyPaths ?? [])) refuse("PATH", "spec worktree is denied; select an allowed registered source");
    const roots = [root, source.path, ...config.vaults.map(value => value.path), ...sources.map(value => value.path)];
    const homeRoot = canonicalPath(home);
    if (roots.some(value => within(value, homeRoot))) refuse("HOME", "VMEM_HOME is inside a registered source/worktree; select a home outside repositories before writing");
    const bindings = [...new Set([root, source.path])].map(value => [value, identity(value)] as const);
    const assertBinding = () => {
      if (lockFile && lockIdentity !== undefined && identity(lockFile) !== lockIdentity) refuse("LOCKED", "spec mutation lock changed ownership; inspect the lock under VMEM_HOME and retry after the other writer finishes", result.path);
      const current = loadRegistry(home);
      if (!isDeepStrictEqual(current.specs?.find(value => value.id === source.id), source) || request.source === undefined && current.specs?.[0]?.id !== source.id || !isDeepStrictEqual(current.denyPaths, config.denyPaths) || !isDeepStrictEqual(current.piiPatterns, config.piiPatterns)) refuse("REGISTRY_DRIFT", "spec registry or screening policy changed during the write; reread the source policy and spec before retrying", result.path);
      if (bindings.some(([path, stamp]) => identity(path) !== stamp) || resolveSpecWorktree(source, root, env) !== root) refuse("DRIFT", "spec worktree identity changed; restore the registered worktree and retry", result.path);
    };
    const initial = discoverSpecs(source, { worktree: root, env }), commonIdentity = identity(initial.commonDir), first = plan(initial);
    result.path = first.path;
    plainPath(root, first.path, config.denyPaths ?? []);
    if (source.write === "none" || channel === "mcp" && source.write !== "mcp") refuse("POLICY", `spec write policy ${source.write} refuses channel ${channel}; select an allowed channel or have the owner update the source policy`, first.path);
    if (request.expectedSha !== undefined && (!/^[a-f0-9]{64}$/.test(request.expectedSha) || hash(first.before) !== request.expectedSha)) refuse("EXPECTED_SHA", "expectedSha does not match the spec; reread vmem spec get and retry with its sha256", first.path);
    screen(first.after, source, config, first.path);
    if (first.before === first.after) { assertBinding(); result.ok = true; result.sha256 = hash(first.before); return result; }
    mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
    const lockDir = join(homeRoot, "spec-mutations"); mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    if (lstatSync(lockDir).isSymbolicLink() || realpathSync(lockDir) !== lockDir) refuse("LOCKED", "spec lock directory is not plain; restore a private lock directory under VMEM_HOME and retry", first.path);
    lockFile = join(lockDir, `${hash(root)}.lock`);
    try { lockFd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { lockFile = undefined; refuse("LOCKED", "spec mutation lock is unavailable; wait for the other mutation, or inspect the interrupted writer's owned lock under VMEM_HOME before retrying", first.path); }
    const ownedLock = fstatSync(lockFd, { bigint: true }); lockIdentity = `${ownedLock.dev}:${ownedLock.ino}`;
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: randomUUID() }) + "\n"); fsyncSync(lockFd);
    assertBinding();
    const current = discoverSpecs(source, { worktree: root, env }), change = plan(current);
    if (current.commonDir !== initial.commonDir || identity(initial.commonDir) !== commonIdentity || change.path !== first.path || change.before !== first.before) refuse("DRIFT", "spec changed since the request read; reread vmem spec get and retry with its sha256", first.path);
    const original = readPlain(root, change.path, config.denyPaths ?? []);
    if (original.source !== change.before) refuse("DRIFT", "spec changed under the mutation lock; reread vmem spec get and retry", change.path);
    const prospective = prospectiveSpecSnapshot(current, new Map([[change.path, change.after]]));
    screen(change.after, source, config, change.path);
    const introduced = introducedSpecErrors(current, prospective, { env });
    if (introduced.length) throw new Refusal(attributeSpecErrors(introduced, change.path));
    const file = plainPath(root, change.path, config.denyPaths ?? []), parent = dirname(file), parentIdentity = identity(parent);
    const candidateTemp = join(parent, `.spec-${randomUUID()}.tmp`);
    const fd = openSync(candidateTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, original.mode);
    temp = candidateTemp;
    try { const stat = fstatSync(fd, { bigint: true }); tempIdentity = `${stat.dev}:${stat.ino}`; fchmodSync(fd, original.mode); writeFileSync(fd, change.after); fsyncSync(fd); } finally { closeSync(fd); }
    assertBinding();
    if (identity(parent) !== parentIdentity || !isDeepStrictEqual(discoverSpecs(source, { worktree: root, env }), current)) refuse("DRIFT", "spec tree changed while validating; reread the source tree and retry the update", change.path);
    const latest = readPlain(root, change.path, config.denyPaths ?? []), staged = readBounded(temp, change.path);
    if (latest.source !== change.before || latest.identity !== original.identity || staged.source !== change.after || staged.identity !== tempIdentity) refuse("DRIFT", "spec target or staged file changed before commit; reread the spec and retry the update", change.path);
    assertBinding();
    renameSync(temp, file); temp = undefined; result.changed = true; result.sha256 = hash(change.after);
    syncDirectory(parent); result.ok = true;
  } catch (error) {
    result.issues = error instanceof Refusal ? error.issues : [{ code: "IO", severity: "error", message: `spec update failed (${error instanceof Error ? error.message : "unavailable file"}); inspect the written file and source binding, repair access and retry`, ...(result.path ? { path: result.path } : {}) }];
    result.path ??= result.issues.find(issue => issue.path)?.path;
  } finally {
    if (temp) {
      try { if (identity(temp) !== tempIdentity) throw new Error("temporary ownership changed"); unlinkSync(temp); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "spec temporary cleanup could not prove owned-file removal; inspect the .spec-*.tmp file in the target directory before retrying (a replacement is preserved)", ...(result.path ? { path: result.path } : {}) }); }
    }
    if (lockFd !== undefined) {
      closeSync(lockFd);
      try { if (lockFile && identity(lockFile) === lockIdentity) unlinkSync(lockFile); }
      catch { result.ok = false; result.issues.push({ code: "CLEANUP", severity: "error", message: "spec lock cleanup failed; inspect the owned lock under VMEM_HOME before retrying", ...(result.path ? { path: result.path } : {}) }); }
    }
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
  catch (error) { refuse("FRONTMATTER", `frontmatter cannot be edited losslessly (${error instanceof Error ? error.message : "invalid block mapping"}); repair its block mapping and retry`, path); }
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
