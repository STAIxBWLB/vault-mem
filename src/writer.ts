import { appendLog } from "./vault-log.ts";
import type { LogEvent } from "./log-types.ts";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { VaultIndex, MAX_NOTE_BYTES } from "./vault-index.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { moveSourcePath, notePath, planOperation, refuse, WriteRefusal } from "./write-operations.ts";
import { validateWrite } from "./write-validation.ts";
import type { ChangeReceipt, PlannedChange, WriteIssue, WriteReceipt, WriteRequest } from "./write-types.ts";
export const MUTATION_LOCK = "mutation.lock";
export const MAX_WRITE_BYTES = 256 * 1024;
export function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Reject linked parent components as well as linked final files. No directories are created here. */
function safePath(root: string, path: string): string {
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..") || path.startsWith("/") || path.includes("\\")) refuse("V04", "unsafe relative path");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) refuse("V04", "path must use plain directories and files", path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
/** Nanosecond file identity used to detect a write racing a single read. */
function stamp(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function readPlain(root: string, path: string): string | null {
  const file = safePath(root, path);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_NOTE_BYTES)) refuse("V09", "file exceeds read bound or is not regular", path);
    const bytes = Buffer.alloc(Math.min(Number(before.size) + 1, MAX_NOTE_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null); size += count;
      if (!count) break;
    }
    const after = fstatSync(fd, { bigint: true });
    if (size > MAX_NOTE_BYTES || stamp(before) !== stamp(after)) refuse("V09", "file changed during read", path);
    const buffer = bytes.subarray(0, size), text = buffer.toString("utf8");
    if (!Buffer.from(text).equals(buffer)) refuse("V01", "note must be valid UTF-8", path);
    return text;
  } finally { closeSync(fd); }
}
/** Flat `notes/*.md` snapshot used by every mutation (other directories such as templates/ and self/ are never read). */
export function snapshot(root: string, denyPaths: string[] = []): Map<string, string> {
  const dir = join(root, "notes");
  if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) refuse("V04", "notes directory changed");
  const notes = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (notes.size >= 10000) refuse("V09", "vault exceeds 10000-note mutation bound");
    const path = `notes/${entry.name}`;
    if (isDenied(join(root, path), denyPaths)) refuse("V06", "mutation snapshot contains a denied note path");
    const source = readPlain(root, path);
    if (source === null) refuse("V09", "note disappeared during snapshot", path);
    notes.set(path, source);
  }
  return notes;
}
function receipts(changes: PlannedChange[]): ChangeReceipt[] {
  return changes.map(change => ({ path: change.path, beforeSha: change.before === null ? null : sha256(change.before), sha256: change.after === null ? null : sha256(change.after), bytes: Buffer.byteLength(change.after ?? "") }));
}
function checkExpected(request: WriteRequest, notes: Map<string, string>): void {
  const expected = { ...request.expectedShas };
  if ("expectedSha" in request.operation && request.operation.expectedSha !== undefined && "path" in request.operation) expected[notePath(request.operation.path)] = request.operation.expectedSha;
  for (const [path, hash] of Object.entries(expected)) {
    // Reports verify an existing snapshot, including legacy names diagnosed by L13.
    // Exact membership is safe here: snapshot() contains only existing flat regular notes.
    // All note mutation targets still go through the stricter notePath naming policy.
    const canonical = (request.operation.op === "report" || request.operation.op === "sanitize") && notes.has(path) ? path : notePath(path), source = notes.get(canonical);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || source === undefined || sha256(source) !== hash) refuse("V09", "expected SHA mismatch", canonical);
  }
}
function duplicateWarnings(request: WriteRequest, notes: Map<string, string>, changes: PlannedChange[]): WriteIssue[] {
  if (request.operation.op !== "create" || !notes.size || !changes[0]?.after) return [];
  const doc = parseFrontmatter(changes[0].after);
  const title = typeof doc.data.title === "string" ? doc.data.title : /^#\s+(.+)$/m.exec(doc.body)?.[1] ?? "";
  const terms = [...new Set(title.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 12);
  if (!terms.length) return [];
  // Disposable FTS preserves dry-run's no-disk-write contract, including on a fresh home.
  const db = new Database(":memory:");
  try {
    db.run("CREATE VIRTUAL TABLE candidates USING fts5(path UNINDEXED,title,description,body,tokenize='unicode61')");
    const insert = db.query("INSERT INTO candidates VALUES (?,?,?,?)");
    for (const [path, source] of notes) {
      let value: ReturnType<typeof parseFrontmatter>;
      try { value = parseFrontmatter(source); } catch { continue; } // Unrelated legacy YAML is not a duplicate candidate.
      insert.run(path, typeof value.data.title === "string" ? value.data.title : path, typeof value.data.description === "string" ? value.data.description : "", value.body);
    }
    const hits = db.query<{ path: string; score: number }, [string]>("SELECT path,bm25(candidates,0,5,2,1) AS score FROM candidates WHERE candidates MATCH ? ORDER BY score,path LIMIT 3").all(terms.map(term => `"${term}"`).join(" AND "));
    return hits.filter(hit => hit.score <= -0.000001).map(hit => ({ code: "V08", severity: "warning", path: hit.path, message: "possible duplicate: FTS title terms match an existing note" }));
  } finally { db.close(); }
}
/** Single mutation entry point. Preview/dry-run perform no writes, including locks and caches. */
export function applyWrite(home: string, request: WriteRequest, options: { env?: NodeJS.ProcessEnv } = {}): WriteReceipt {
  let lockFd: number | undefined, lockFile: string | undefined, lockIdentity: { ino: number; dev: number } | undefined;
  let index: VaultIndex | undefined;
  const temps = new Set<string>(), createdDirs: string[] = [], committed: PlannedChange[] = [];
  let changes: PlannedChange[] = [], issues: WriteIssue[] = [], fingerprint: string | undefined, root = "", applied = false, indexUpdated = false;
  let result: WriteReceipt | undefined;
  const recordError = (code: string, message: string, path?: string) => issues.push({ code, severity: "error", message, ...(path ? { path } : {}) });
  try {
    if (!request || typeof request !== "object" || !request.operation || typeof request.operation !== "object" || typeof request.vault !== "string") refuse("V01", "invalid write request");
    if (Object.keys(request).some(key => !["vault", "operation", "channel", "dryRun", "confirm", "fingerprint", "expectedShas", "log"].includes(key)) || [request.dryRun, request.confirm].some(value => value !== undefined && typeof value !== "boolean")) refuse("V01", "unknown request option or invalid boolean");
    if (request.expectedShas !== undefined && (!request.expectedShas || typeof request.expectedShas !== "object" || Array.isArray(request.expectedShas))) refuse("V09", "expectedShas must be a mapping");
    if (request.channel !== undefined && !["cli", "mcp"].includes(request.channel)) refuse("POLICY", "unknown write channel");
    const config = loadRegistry(home), vault = config.vaults.find(value => value.id === request.vault);
    if (!vault) refuse("V04", "unknown vault id");
    if (request.operation.op !== "check" && (vault.write === "none" || (request.channel === "mcp" && vault.write !== "mcp"))) refuse("POLICY", "vault write policy refuses this channel");
    root = realpathSync(vault.path);
    if (root !== vault.path || isDenied(root, config.denyPaths)) refuse("V06", "vault path denied or changed");
    if (config.vaults.some(value => canonicalPath(home) === value.path || canonicalPath(home).startsWith(`${value.path}/`))) refuse("V04", "VMEM_HOME must be outside registered vaults");
    const twoStep = ["move", "delete", "tidy"].includes(request.operation.op);
    const preview = request.operation.op === "check" || request.dryRun === true || (twoStep && request.confirm !== true);
    if (!preview) {
      lockFile = join(root, MUTATION_LOCK);
      try { lockFd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { lockFile = undefined; refuse("LOCKED", "vault mutation lock unavailable; existing lock is preserved"); }
      const stat = fstatSync(lockFd); lockIdentity = { ino: Number(stat.ino), dev: Number(stat.dev) };
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), created: new Date().toISOString() }) + "\n");
      fsyncSync(lockFd);
    }
    const notes = snapshot(root, config.denyPaths);
    checkExpected(request, notes);
    let reportBefore: string | null | undefined;
    if (request.operation.op === "report") {
      // Planning validates the report's exact relative path before it can be read.
      planOperation(request.operation, notes, null);
      if (isDenied(join(root, request.operation.path), config.denyPaths)) refuse("V06", "report output path is denied");
      reportBefore = readPlain(root, request.operation.path);
    }
    changes = planOperation(request.operation, notes, reportBefore);
    for (const change of changes) if (isDenied(join(root, change.path), config.denyPaths)) refuse("V06", "planned mutation path is denied", change.path);
    issues = validateWrite(changes, { vault, config, notes, operation: request.operation });
    if (!issues.some(issue => issue.severity === "error")) issues.push(...duplicateWarnings(request, notes, changes));
    const input = { vault: request.vault, channel: request.channel ?? "cli", operation: request.operation, expectedShas: request.expectedShas ?? {}, log: request.log ?? null };
    const identity = lstatSync(root);
    fingerprint = sha256(canonical({ input, vault, policy: { denyPaths: config.denyPaths ?? [], piiPatterns: config.piiPatterns ?? [] }, root, identity: [identity.dev, identity.ino], files: [...notes].map(([path, text]) => [path, sha256(text)]), changes: receipts(changes) }));
    if (twoStep && request.confirm === true && (typeof request.fingerprint !== "string" || request.fingerprint !== fingerprint)) refuse("V09", "stale or missing preview fingerprint");
    if (issues.some(issue => issue.severity === "error")) return result = { ok: false, applied: false, issues, changes: receipts(changes), fingerprint, indexUpdated: false };
    if (preview) return result = { ok: true, applied: false, preview: true, ...(request.operation.op === "link" && !changes.length ? {unchanged:true} : {}), issues, changes: receipts(changes), fingerprint, indexUpdated: false };
    if (!changes.length) return result = { ok: true, applied: false, ...(request.operation.op === "link" ? {unchanged:true} : {}), issues, changes: [], fingerprint, indexUpdated: false };
    index = new VaultIndex(home, vault, config.vaults.map(value => value.path));
    const backups = new Map<string, string>(), staged = new Map<string, string>();
    const ensureDir = (dir: string) => {
      if (dir === root) return;
      try { if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) refuse("V04", "unsafe output directory"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ensureDir(dirname(dir)); mkdirSync(dir, { mode: 0o700 }); createdDirs.push(dir);
      }
    };
    const stage = (file: string, text: string) => {
      const temp = join(dirname(file), `.vmem-${randomUUID()}.tmp`);
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temps.add(temp);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      return temp;
    };
    for (const change of changes) {
      const file = safePath(root, change.path); ensureDir(dirname(file));
      if (change.before !== null) backups.set(change.path, stage(file, change.before));
      if (change.after !== null) staged.set(change.path, stage(file, change.after));
    }
    try {
      // Detect non-cooperating writers before any rename; cooperating callers use our lock.
      const currentRoot = lstatSync(root);
      if (currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino) refuse("V09", "vault identity changed while staging");
      // Full content recheck: shared mmap writes can change bytes without moving any stat field.
      const current = snapshot(root, config.denyPaths);
      if (current.size !== notes.size || [...current].some(([path, text]) => notes.get(path) !== text)) refuse("V09", "vault changed while staging");
      for (const change of changes) {
        const file = safePath(root, change.path);
        if (readPlain(root, change.path) !== change.before) refuse("V09", "file changed while staging", change.path);
        if (change.after === null) unlinkSync(file);
        else { const temp = staged.get(change.path)!; renameSync(temp, file); temps.delete(temp); }
        committed.push(change);
      }
      for (const dir of new Set(changes.map(change => dirname(join(root, change.path))))) syncDirectory(dir);
      const refreshed = index.scan(false, { skipInvalidFrontmatter: true });
      for (const path of refreshed.skipped ?? []) issues.push({ code: "V01", severity: "warning", path: `notes/${path}`, message: "legacy invalid frontmatter omitted from derived index; note unchanged" });
      indexUpdated = true; applied = true;
    } catch (error) {
      for (const change of [...committed].reverse()) {
        try {
          const file = safePath(root, change.path);
          if (readPlain(root, change.path) !== change.after) throw new Error("external write detected before rollback");
          if (change.before === null) unlinkSync(file);
          else { const backup = backups.get(change.path)!; renameSync(backup, file); temps.delete(backup); }
        } catch {
          applied = true;
          const backup = backups.get(change.path);
          if (backup) temps.delete(backup); // Recovery copy must survive failed rollback or external drift.
          recordError("ROLLBACK", "rollback refused or failed; external edits preserved and original backup retained when available", backup ? backup.slice(root.length + 1) : change.path);
        }
      }
      for (const dir of new Set(committed.map(change => dirname(join(root, change.path))))) {
        try { syncDirectory(dir); } catch { recordError("ROLLBACK", "rollback directory flush failed"); }
      }
      try { index.scan(false, { skipInvalidFrontmatter: true }); } catch { recordError("INDEX", "derived index refresh failed; rebuild after resolving filesystem error"); }
      throw error;
    }
    result = { ok: true, applied, issues, changes: receipts(changes), fingerprint, indexUpdated };
    if (request.log !== false) {
      const op = request.operation;
      const type = op.op === "link" ? "CONNECT" : op.op === "move" ? "ROUTE" : ["supersede", "tidy"].includes(op.op) ? "RETHINK" : "EXTRACT";
      const source = op.op === "move" ? moveSourcePath(op.from, notes) : op.op === "link" ? notePath(op.from) : op.op === "supersede" ? notePath(op.old) : op.op === "delete" ? notePath(op.path) : `vmem:${op.op}`;
      const dest = op.op === "move" || op.op === "link" ? notePath(op.to) : op.op === "supersede" ? notePath(op.next) : op.op === "delete" ? undefined : changes.find(change => change.after !== null)?.path;
      const event: LogEvent = request.log ?? { type, project: "-", source, ...(dest ? { dest } : {}), note: op.op };
      try { result.log = appendLog(home, { vault: request.vault, event, channel: request.channel }, { env: options.env, binding: { vault, denyPaths: config.denyPaths ?? [], piiPatterns: config.piiPatterns ?? [], dev: Number(identity.dev), ino: Number(identity.ino) } }); }
      catch { result.log = { ok: false, appended: null, synced: false, bytesWritten: null, issues: [{ code: "LOG_IO", severity: "error", message: "log append failed after successful mutation" }] }; }
      result.logged = result.log.appended === true && result.log.synced;
    }
  } catch (error) {
    if (error instanceof WriteRefusal) issues.push(...error.issues);
    else recordError("IO", "write operation failed; inspect filesystem permissions and retry");
    result = { ok: false, applied, issues, changes: receipts(changes), ...(fingerprint ? { fingerprint } : {}), indexUpdated };
  } finally {
    try { index?.close(); } catch { recordError("INDEX", "derived index close failed"); }
    for (const temp of temps) {
      try { unlinkSync(temp); } catch { recordError("CLEANUP", "owned temporary cleanup failed; inspect .vmem temporary files"); }
    }
    // Only empty directories created by this invocation are eligible for removal on failure.
    if (!applied) for (const dir of createdDirs.reverse()) { try { rmdirSync(dir); } catch { recordError("CLEANUP", "owned empty directory cleanup failed"); } }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { recordError("CLEANUP", "mutation lock descriptor close failed"); }
      try {
        const stat = lstatSync(lockFile!);
        if (Number(stat.ino) !== lockIdentity?.ino || Number(stat.dev) !== lockIdentity?.dev || stat.isSymbolicLink()) recordError("CLEANUP", "mutation lock ownership changed; retained lock");
        else unlinkSync(lockFile!);
      } catch { recordError("CLEANUP", "mutation lock retained; inspect ownership before manual recovery"); }
    }
    if (result) {
      const possibleDuplicates = issues.filter(issue => issue.code === "V08" && issue.severity === "warning" && issue.path).map(issue => issue.path!);
      if (possibleDuplicates.length) result.possibleDuplicates = possibleDuplicates;
      if (issues.some(issue => issue.severity === "error")) result.ok = false;
    }
  }
  return result!;
}
