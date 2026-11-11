import { capturePublicationPath, publishFile, cleanupOwnedFile, PublicationDrift, type PublicationPath } from "./write-files.ts";
import { anchorIndex, normalizeTarget, noteKey, extractLinks } from "./links.ts";
import { localDate } from "./local-date.ts";
import { appendLog, checkLogEvent, matchesBinding } from "./vault-log.ts";
import type { LogEvent } from "./log-types.ts";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { VaultIndex, MAX_NOTE_BYTES, GRAMS_COLUMNS, gramPhrase, grams, splitTerms } from "./vault-index.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { moveSourcePath, notePath, planOperation, planMerge, stampContentChanges, refuse, WriteRefusal } from "./write-operations.ts";
import { MAX_REPORT_BYTES, createWriteValidator } from "./write-validation.ts";
import type { PiiSurface } from "./config.ts";
import { unenforceablePii, mutationVault } from "./config.ts";
import type { LogBinding } from "./log-types.ts";
import type { MergePreview, ChangeReceipt, PlannedChange, WriteIssue, WriteReceipt, WriteRequest } from "./write-types.ts";
export const MUTATION_LOCK = "mutation.lock";
export { MAX_WRITE_BYTES } from "./write-types.ts";
const MAX_MERGE_ACK_BYTES = 224 * 1024;
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
function readPlain(root: string, path: string, maximum = MAX_NOTE_BYTES): string | null {
  const file = safePath(root, path);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) refuse("V09", "file exceeds read bound or is not regular", path);
    const bytes = Buffer.alloc(Math.min(Number(before.size) + 1, maximum + 1));
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null); size += count;
      if (!count) break;
    }
    const after = fstatSync(fd, { bigint: true });
    if (size > maximum || stamp(before) !== stamp(after)) refuse("V09", "file changed during read", path);
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
/** Preserve referenced content identity and the existing no-self-supersession invariant. */
function checkMergeReferences(preview: MergePreview, notes: Map<string, string>, copiedBody: string): void {
  const anchors = anchorIndex(parseFrontmatter(notes.get(preview.keep)!).body);
  const absorbed = parseFrontmatter(notes.get(preview.absorb)!);
  const supersedes = typeof absorbed.data.supersedes === "string" ? [absorbed.data.supersedes] : Array.isArray(absorbed.data.supersedes) ? absorbed.data.supersedes : [];
  if (supersedes.some(value => typeof value === "string" && extractLinks(value).some(link => noteKey(link.target) === noteKey(preview.keep)))) {
    refuse("V10", `${preview.absorb} supersedes ${preview.keep}, so keep is the older note; swap keep and absorb, then request a fresh merge preview`, preview.absorb);
  }
  // Only surviving copied self-fragments change their containing note to keep.
  // Removed title/Topics content is excluded; these links need no target rewrite.
  const selfFragments = extractLinks(copiedBody)
    .filter(link => link.target === "" && (link.heading !== null || link.block !== null))
    .map(link => ({ path: preview.absorb, field: "body", heading: link.heading ?? undefined, block: link.block ?? undefined }));
  for (const link of [...preview.inboundLinks, ...selfFragments]) {
    if (link.path === preview.keep && /^superseded_by(?:$|\[)/.test(link.field)) refuse("V10", `${preview.keep} is superseded by ${preview.absorb}; swap keep and absorb, then request a fresh merge preview`, preview.keep);
    const fragment = link.block ? `^${link.block}` : link.heading;
    const collides = link.block ? anchors.blocks.has(normalizeTarget(link.block)) : link.heading ? anchors.headings.has(normalizeTarget(link.heading)) : false;
    if (fragment && collides) refuse("V03", `merge fragment ${JSON.stringify(fragment)} from ${preview.absorb} collides with ${preview.keep}; rename the heading or block anchor in one note and rerun the merge preview`, link.path);
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
    db.run(`CREATE VIRTUAL TABLE candidates USING fts5(path UNINDEXED,title,description,body,tokenize='unicode61');
      CREATE VIRTUAL TABLE grams USING fts5(${GRAMS_COLUMNS},tokenize='unicode61');`);
    const insert = db.query("INSERT INTO candidates VALUES (?,?,?,?)"), insertGrams = db.query("INSERT INTO grams VALUES (?,?,?,?)");
    for (const [path, source] of notes) {
      let value: ReturnType<typeof parseFrontmatter>;
      try { value = parseFrontmatter(source); } catch { continue; } // Unrelated legacy YAML is not a duplicate candidate.
      const title = typeof value.data.title === "string" ? value.data.title : path, description = typeof value.data.description === "string" ? value.data.description : "";
      insert.run(path, title, description, value.body); insertGrams.run(path, grams(title), grams(description), grams(value.body));
    }
    // Same term split as VaultIndex.search: CJK terms match substrings through the bigram table.
    const { tokens, runs } = splitTerms(terms);
    const hits = runs.length
      ? db.query<{ path: string; score: number }, string[]>(`SELECT path,bm25(grams,0,5,2,1) AS score FROM grams WHERE grams MATCH ? ${tokens.length ? "AND path IN (SELECT path FROM candidates WHERE candidates MATCH ?)" : ""} ORDER BY score,path LIMIT 3`).all(runs.map(gramPhrase).join(" AND "), ...(tokens.length ? [tokens.join(" AND ")] : []))
      : db.query<{ path: string; score: number }, [string]>("SELECT path,bm25(candidates,0,5,2,1) AS score FROM candidates WHERE candidates MATCH ? ORDER BY score,path LIMIT 3").all(tokens.join(" AND "));
    return hits.filter(hit => hit.score <= -0.000001).map(hit => ({ code: "V08", severity: "warning", path: hit.path, message: "possible duplicate: FTS title terms match an existing note" }));
  } finally { db.close(); }
}
/** Single mutation entry point. Preview/dry-run perform no writes, including locks and caches. */
/** `options.binding` (internal callers composing several writes) refuses with VAULT_DRIFT unless the registry still matches it. */
export function applyWrite(home: string, request: WriteRequest, options: { env?: NodeJS.ProcessEnv; piiSurface?: PiiSurface; binding?: LogBinding; now?: Date } = {}): WriteReceipt {
  let lockFd: number | undefined, lockFile: string | undefined;
  let index: VaultIndex | undefined;
  const temps = new Map<string, { fd: number; remove: boolean }>(), publicationPaths = new Map<string, PublicationPath>(), createdDirs: string[] = [], committed: PlannedChange[] = [];
  let changes: PlannedChange[] = [], issues: WriteIssue[] = [], fingerprint: string | undefined, root = "", applied = false, indexUpdated = false;
  let result: WriteReceipt | undefined;
  let appliedPaths: Set<string> | undefined;
  const backups = new Map<string, string>(), backupNames = new Set<string>(), retainedBackups = new Set<string>();
  const retainBackup = (path: string) => {
    const backup = backups.get(path);
    if (backup && temps.get(backup)?.remove) {
      temps.get(backup)!.remove = false; retainedBackups.add(backup.slice(root.length + 1));
    }
  };
  const reportedChanges = () => receipts(changes).map(change => appliedPaths
    ? { ...change, applied: appliedPaths.has(change.path) } : change);
  const dateWarnings: WriteIssue[] = [];
  let mergePreview: MergePreview | undefined, mergeCopiedBody = "";
  const recordError = (code: string, message: string, path?: string) => issues.push({ code, severity: "error", message, ...(path ? { path } : {}) });
  try {
    if (!request || typeof request !== "object" || !request.operation || typeof request.operation !== "object" || typeof request.vault !== "string") refuse("V01", "invalid write request");
    if (Object.keys(request).some(key => !["vault", "operation", "channel", "dryRun", "confirm", "fingerprint", "expectedShas", "log"].includes(key)) || [request.dryRun, request.confirm].some(value => value !== undefined && typeof value !== "boolean")) refuse("V01", "unknown request option or invalid boolean");
    if (request.expectedShas !== undefined && (!request.expectedShas || typeof request.expectedShas !== "object" || Array.isArray(request.expectedShas))) refuse("V09", "expectedShas must be a mapping");
    if (request.channel !== undefined && !["cli", "mcp"].includes(request.channel)) refuse("POLICY", "unknown write channel");
    const config = loadRegistry(home), vault = config.vaults.find(value => value.id === request.vault);
    if (options.binding && !matchesBinding(config, request.vault, options.binding)) refuse("VAULT_DRIFT", "vault identity or policy changed since the run started; nothing written");
    if (!vault) refuse("V04", "unknown vault id");
    const unenforceable = unenforceablePii(vault);
    if (unenforceable) refuse("PII_POLICY", unenforceable);
    if (request.operation.op !== "check" && (vault.write === "none" || (request.channel === "mcp" && vault.write !== "mcp"))) refuse("POLICY", "vault write policy refuses this channel");
    root = realpathSync(vault.path);
    if (root !== vault.path || isDenied(root, config.denyPaths)) refuse("V06", "vault path denied or changed");
    if (config.vaults.some(value => canonicalPath(home) === value.path || canonicalPath(home).startsWith(`${value.path}/`))) refuse("V04", "VMEM_HOME must be outside registered vaults");
    // A given event is checked like `log append` before any lock or note change, so a bad event never leaves an unlogged write.
    if (request.log !== undefined && request.log !== false && request.operation.op !== "check") {
      const logIssues = checkLogEvent(home, { vault: request.vault, event: request.log, channel: request.channel }, options.env);
      if (logIssues.length) throw new WriteRefusal(logIssues.map(issue => ({ ...issue, message: `log event refused, nothing written: ${issue.message}; fix the event fields (rules as for \`log append\`) or omit the event for the default line` })));
    }
    const twoStep = ["move", "delete", "tidy", "merge"].includes(request.operation.op);
    const preview = request.operation.op === "check" || request.dryRun === true || (twoStep && request.confirm !== true);
    if (!preview) {
      lockFile = join(root, MUTATION_LOCK);
      try { lockFd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { lockFile = undefined; refuse("LOCKED", "vault mutation lock unavailable; existing lock is preserved"); }
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
      reportBefore = readPlain(root, request.operation.path, MAX_REPORT_BYTES);
    }
    if (request.operation.op === "merge") {
      const plan = planMerge(request.operation, notes); changes = plan.changes; mergePreview = plan.preview; mergeCopiedBody = plan.copiedBody;
    } else changes = planOperation(request.operation, notes, reportBefore);
    for (const change of changes) if (isDenied(join(root, change.path), config.denyPaths)) refuse("V06", "planned mutation path is denied", change.path);
    const validation = { vault, config, notes, operation: request.operation, ...(options.piiSurface ? { piiSurface: options.piiSurface } : {}) };
    // Validate the caller's candidate first: replacing `updated` must not hide a
    // secret, oversized input or other refusal that existing validation catches.
    const validateCandidate = createWriteValidator(validation);
    const validate = (candidate: PlannedChange[]) => validateCandidate(candidate).map(issue => request.operation.op === "merge" && issue.severity === "error"
      ? { ...issue, message: `${issue.message}; repair the indicated notes or links, then request a fresh merge preview` } : issue);
    issues = validate(changes);
    if (!issues.some(issue => issue.severity === "error")) {
      // Check only screened candidates: diagnostics must not echo an unsafe fragment.
      if (mergePreview) checkMergeReferences(mergePreview, notes, mergeCopiedBody);
      const stamped = stampContentChanges(request.operation, changes, localDate(options.now), dateWarnings);
      if (stamped.some((change, index) => change.after !== changes[index]?.after) || stamped.length !== changes.length) {
        changes = stamped;
        issues = validate(changes);
      }
      issues.push(...dateWarnings);
      if (!issues.some(issue => issue.severity === "error")) issues.push(...duplicateWarnings(request, notes, changes));
    }
    // The log event is not part of the fingerprint: move/delete take it on the confirm call only.
    const input = { vault: request.vault, channel: request.channel ?? "cli", operation: request.operation, expectedShas: request.expectedShas ?? {} };
    const identity = lstatSync(root);
    // The identity every later commit check uses must still be the bound root, not a directory swapped in meanwhile.
    if (options.binding && (Number(identity.dev) !== options.binding.dev || Number(identity.ino) !== options.binding.ino)) refuse("VAULT_DRIFT", "vault root changed since the run started; nothing written");
    fingerprint = sha256(canonical({ input, vault: mutationVault(vault), policy: { denyPaths: config.denyPaths ?? [], piiPatterns: config.piiPatterns ?? [], piiSurface: options.piiSurface ?? "notes" }, root, identity: [identity.dev, identity.ino], files: [...notes].map(([path, text]) => [path, sha256(text)]), changes: receipts(changes) }));
    if (twoStep && request.confirm === true && (typeof request.fingerprint !== "string" || request.fingerprint !== fingerprint)) refuse("V09", request.operation.op === "merge" ? "stale or missing merge fingerprint; request a fresh merge preview and confirm with that fingerprint" : "stale or missing preview fingerprint");
    if (mergePreview && request.channel === "mcp" && !issues.some(issue => issue.severity === "error") && Buffer.byteLength(JSON.stringify({ merge: mergePreview, issues, changes: receipts(changes), fingerprint })) > MAX_MERGE_ACK_BYTES) {
      // The complete plan must be reviewable before a merge can publish. Keep the refusal compact too.
      changes = []; mergePreview = undefined; issues = [];
      refuse("V09", "merge preview exceeds the bounded MCP acknowledgement size; use CLI --json for both preview and confirm, or reduce the notes and inbound links before requesting a fresh preview");
    }
    if (issues.some(issue => issue.severity === "error")) return result = { ok: false, applied: false, issues, changes: receipts(changes), fingerprint, indexUpdated: false };
    if (preview) return result = { ok: true, applied: false, preview: true, ...(request.operation.op === "link" && !changes.length ? {unchanged:true} : {}), issues, changes: receipts(changes), fingerprint, indexUpdated: false };
    if (!changes.length) return result = { ok: true, applied: false, ...(request.operation.op === "link" ? {unchanged:true} : {}), issues, changes: [], fingerprint, indexUpdated: false };
    index = new VaultIndex(home, vault, config.vaults.map(value => value.path));
    const staged = new Map<string, string>();
    const ensureDir = (dir: string) => {
      if (dir === root) return;
      try { if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) refuse("V04", "unsafe output directory"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ensureDir(dirname(dir)); mkdirSync(dir, { mode: 0o700 }); createdDirs.push(dir);
      }
    };
    // ponytail: staging holds up to two descriptors per changed note until cleanup; the process fd ceiling
    // may refuse a large batch with EMFILE before publication. Split such a batch before retrying.
    const stage = (file: string, text: string) => {
      const temp = join(dirname(file), `.vmem-${randomUUID()}.tmp`);
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temps.set(temp, { fd, remove: true });
      writeFileSync(fd, text); fsyncSync(fd);
      return temp;
    };
    for (const change of changes) {
      const file = safePath(root, change.path); ensureDir(dirname(file));
      publicationPaths.set(change.path, capturePublicationPath(root, file));
      if (change.before !== null) { const backup = stage(file, change.before); backups.set(change.path, backup); backupNames.add(backup); }
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
        if (readPlain(root, change.path, request.operation.op === "report" ? MAX_REPORT_BYTES : MAX_NOTE_BYTES) !== change.before) refuse("V09", "file changed while staging", change.path);
        const temp = staged.get(change.path);
        publishFile(publicationPaths.get(change.path)!, change.after === null ? { kind: "unlink" } : { kind: "rename", temp: temp! }, () => {
          committed.push(change);
          if (temp) temps.get(temp)!.remove = false;
        });
      }
      for (const dir of new Set(changes.map(change => dirname(join(root, change.path))))) syncDirectory(dir);
      const refreshed = index.scan(false, { skipInvalidFrontmatter: true });
      for (const path of refreshed.skipped ?? []) issues.push({ code: "V01", severity: "warning", path: `notes/${path}`, message: "legacy invalid frontmatter omitted from derived index; note unchanged" });
      indexUpdated = true; applied = true;
    } catch (error) {
      if (error instanceof PublicationDrift) {
        // Namespace ownership is no longer proved. Do not roll back, flush or rescan through that path.
        applied = committed.length > 0;
        appliedPaths = new Set(committed.map(change => change.path));
        for (const change of committed) retainBackup(change.path);
        throw error;
      }
      const outstanding = new Set(committed.map(change => change.path));
      let rollbackDrift: PublicationDrift | undefined;
      for (const change of [...committed].reverse()) {
        let restored = false;
        try {
          const file = safePath(root, change.path);
          if (readPlain(root, change.path, request.operation.op === "report" ? MAX_REPORT_BYTES : MAX_NOTE_BYTES) !== change.after) throw new Error("external write detected before rollback");
          const backup = backups.get(change.path);
          publishFile(publicationPaths.get(change.path)!, change.before === null ? { kind: "unlink" } : { kind: "rename", temp: backup! }, () => {
            restored = true; outstanding.delete(change.path);
            if (backup) temps.get(backup)!.remove = false;
          });
        } catch (rollbackError) {
          if (!restored) retainBackup(change.path);
          const backup = backups.get(change.path);
          if (rollbackError instanceof PublicationDrift) {
            rollbackDrift = rollbackError;
            let outcome: string;
            if (change.before === null) outcome = restored ? "rollback removed the created target" : "rollback could not remove the created target";
            else outcome = restored ? "rollback restored the original target; its backup name was consumed" : "rollback was not published; inspect the listed retained backup";
            recordError("ROLLBACK", `${outcome}; publication path identity or containment changed during rollback; ${outstanding.size > 0 ? "changes remain applied" : "no applied changes remain"}; stop concurrent writers, inspect the registered root and target, and restore the original plain parent directories before another mutation`, change.path);
            for (const path of outstanding) retainBackup(path);
            break;
          }
          recordError("ROLLBACK", "rollback refused or failed; external edits preserved and original backup retained when available", backup ? backup.slice(root.length + 1) : change.path);
        }
      }
      applied = outstanding.size > 0;
      if (applied || rollbackDrift) appliedPaths = outstanding;
      // The rollback diagnostic records drift once; the outer handler must retain the original forward cause.
      if (rollbackDrift) throw error;
      for (const dir of new Set(committed.map(change => dirname(join(root, change.path))))) {
        try { syncDirectory(dir); } catch { recordError("ROLLBACK", "rollback directory flush failed"); }
      }
      try { index.scan(false, { skipInvalidFrontmatter: true }); } catch { recordError("INDEX", "derived index refresh failed; rebuild after resolving filesystem error"); }
      throw error;
    }
    result = { ok: true, applied, issues, changes: receipts(changes), fingerprint, indexUpdated };
    if (request.log !== false) {
      const op = request.operation;
      const type = op.op === "link" ? "CONNECT" : op.op === "move" ? "ROUTE" : ["supersede", "tidy", "merge"].includes(op.op) ? "RETHINK" : "EXTRACT";
      const source = op.op === "move" ? moveSourcePath(op.from, notes) : op.op === "link" ? notePath(op.from) : op.op === "supersede" ? notePath(op.old) : op.op === "merge" ? notePath(op.absorb) : op.op === "delete" ? notePath(op.path) : `vmem:${op.op}`;
      const dest = op.op === "move" || op.op === "link" ? notePath(op.to) : op.op === "supersede" ? notePath(op.next) : op.op === "merge" ? notePath(op.keep) : op.op === "delete" ? undefined : changes.find(change => change.after !== null)?.path;
      const event: LogEvent = request.log ?? { type, project: "-", source, ...(dest ? { dest } : {}), note: op.op };
      try { result.log = appendLog(home, { vault: request.vault, event, channel: request.channel }, { env: options.env, binding: { vault, denyPaths: config.denyPaths ?? [], piiPatterns: config.piiPatterns ?? [], dev: Number(identity.dev), ino: Number(identity.ino) } }); }
      catch { result.log = { ok: false, appended: null, synced: false, bytesWritten: null, issues: [{ code: "LOG_IO", severity: "error", message: "log append failed after successful mutation" }] }; }
      result.logged = result.log.appended === true && result.log.synced;
    }
  } catch (error) {
    if (error instanceof WriteRefusal) issues.push(...error.issues.map(issue => request?.operation?.op === "merge" && !issue.message.includes(";")
      ? { ...issue, message: `${issue.message}; repair the indicated merge input or note, then request a fresh preview` } : issue));
    else if (error instanceof PublicationDrift) recordError("V09", error.message, error.file.slice(root.length + 1));
    else {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const cause = error instanceof Error ? error.message.slice(0, 500) : "unknown I/O failure";
      recordError("IO", `write operation failed${typeof code === "string" ? ` (${code})` : ""}: ${cause}; inspect filesystem permissions, storage and the write receipt before retrying`);
    }
    result = { ok: false, applied, issues, changes: reportedChanges(), ...(fingerprint ? { fingerprint } : {}), indexUpdated };
  } finally {
    try { index?.close(); } catch { recordError("INDEX", "derived index close failed"); }
    for (const [temp, owned] of temps) {
      try { if (owned.remove) cleanupOwnedFile(temp, owned.fd); }
      catch (error) {
        // A swapped parent can make the original name unreachable while the owned backup still has a link.
        // Report its original name for inspection, but never claim an unlinked/replaced inode was retained.
        if (backupNames.has(temp)) {
          try { if (fstatSync(owned.fd).nlink > 0) retainedBackups.add(temp.slice(root.length + 1)); } catch { /* The cleanup issue below remains authoritative. */ }
        }
        recordError("CLEANUP", `owned temporary cleanup failed; inspect .vmem temporary files and preserve replacements: ${error instanceof Error ? error.message : String(error)}`, temp.slice(root.length + 1));
      }
      finally { try { closeSync(owned.fd); } catch { recordError("CLEANUP", "temporary descriptor close failed; inspect retained .vmem files"); } }
    }
    // Only empty directories created by this invocation are eligible for removal on failure.
    if (!applied) for (const dir of createdDirs.reverse()) { try { rmdirSync(dir); } catch { recordError("CLEANUP", "owned empty directory cleanup failed"); } }
    if (lockFd !== undefined) {
      try { cleanupOwnedFile(lockFile!, lockFd); }
      catch (error) { recordError("CLEANUP", `mutation lock retained; inspect ownership before manual recovery: ${error instanceof Error ? error.message : String(error)}`); }
      finally { try { closeSync(lockFd); } catch { recordError("CLEANUP", "mutation lock descriptor close failed"); } }
    }
    if (result) {
      if (retainedBackups.size) result.retainedBackups = [...retainedBackups];
      const possibleDuplicates = issues.filter(issue => issue.code === "V08" && issue.severity === "warning" && issue.path).map(issue => issue.path!);
      if (possibleDuplicates.length) result.possibleDuplicates = possibleDuplicates;
      if (issues.some(issue => issue.severity === "error")) result.ok = false;
      if (result.ok && result.applied) for (const warning of dateWarnings) warning.message = `content was saved; ${warning.message}`;
      if (result.ok && mergePreview) result.merge = mergePreview;
    }
  }
  return result!;
}
