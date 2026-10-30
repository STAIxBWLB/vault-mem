import { compileLogFilter } from "./log-filter.ts";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { loadRegistry, syncDirectory } from "./registry.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { formatLogEvent, LOG_TYPES } from "./log-format.ts";
import type { LogBinding, LogContext, LogReadOptions, LogReadResult, LogReceipt, LogRequest } from "./log-types.ts";
import type { WriteIssue } from "./write-types.ts";
import type { VaultSpec, VmemConfig } from "./config.ts";
export const LOG_LOCK = "log.lock";
export const MAX_LOG_READ_BYTES = 32 * 1024 * 1024;
export const LARGE_LOG_LINES = 20000;
const MAX_READ_LINE_BYTES = 4096;
export const MAX_LOG_RESULT_BYTES = 128 * 1024;
class LogRefused extends Error {
  constructor(readonly issues: WriteIssue[]) { super(issues[0]?.message ?? "log refused"); }
}
function refuse(code: string, message: string): never { throw new LogRefused([{ code, severity: "error", message }]); }
function boundedPlain(file: string, maximum: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) refuse("L09", "registry must be a bounded plain file");
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refuse("L09", "registry changed while reading");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) refuse("L09", "registry must be UTF-8");
    return text;
  } finally { closeSync(fd); }
}
function registryIds(file: string, denyPaths: string[] = []): Set<string> {
  if (isDenied(canonicalPath(file), denyPaths)) refuse("L09", "registry path is denied");
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(boundedPlain(file, 1024 * 1024)); }
  catch (error) { if (error instanceof LogRefused) throw error; refuse("L09", "cannot read project registry"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>).projects)) refuse("L09", "registry requires a projects array");
  const result = new Set<string>(), visited = new Set<object>();
  function collect(items: unknown[], depth: number): void {
    if (depth > 8 || visited.has(items)) refuse("L09", "registry nesting is invalid");
    visited.add(items);
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) refuse("L09", "registry projects must be objects");
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || result.has(entry.id) || result.size >= 10000) refuse("L09", "registry project id is invalid, duplicated or exceeds bound");
      result.add(entry.id);
      if (entry.sub_projects !== undefined) {
        if (!Array.isArray(entry.sub_projects)) refuse("L09", "registry sub_projects must be an array");
        collect(entry.sub_projects, depth + 1);
      }
    }
  }
  collect((parsed as { projects: unknown[] }).projects, 0);
  return result;
}
function context(home: string, id: string, channel: "cli" | "mcp" | undefined, write: boolean): LogContext {
  const config = loadRegistry(home), vault = config.vaults.find(item => item.id === id);
  if (!vault) refuse("L09", "unknown vault id");
  if (channel !== undefined && channel !== "cli" && channel !== "mcp") refuse("POLICY", "unknown log channel");
  if (write && (vault.write === "none" || (channel === "mcp" && vault.write !== "mcp"))) refuse("POLICY", "vault write policy refuses log append");
  if (realpathSync(vault.path) !== vault.path || !lstatSync(vault.path).isDirectory()) refuse("L09", "registered vault path changed");
  if (isDenied(join(vault.path, "log"), config.denyPaths)) refuse("V06", "log path is denied");
  return { vault, config, channel, ...(write && vault.registry ? { projectIds: registryIds(vault.registry, config.denyPaths) } : {}) };
}
/** One O_APPEND write per event. A separate cooperative lock permits safe short-write rollback. */
/** Bind a later append to the vault spec, path policy and root identity resolved now (refused with LOG_DRIFT if they change). */
export function logBinding(vault: VaultSpec, config: VmemConfig): LogBinding {
  const identity = lstatSync(vault.path);
  return { vault, denyPaths: config.denyPaths ?? [], piiPatterns: config.piiPatterns ?? [], dev: Number(identity.dev), ino: Number(identity.ino) };
}
/** True when the registered vault still equals the binding: spec, path policy and root identity. Never throws. */
export function matchesBinding(config: VmemConfig, id: string, binding: LogBinding): boolean {
  const vault = config.vaults.find(v => v.id === id);
  if (!vault || JSON.stringify(vault) !== JSON.stringify(binding.vault) || JSON.stringify(config.denyPaths ?? []) !== JSON.stringify(binding.denyPaths) || JSON.stringify(config.piiPatterns ?? []) !== JSON.stringify(binding.piiPatterns)) return false;
  try { const identity = lstatSync(vault.path); return Number(identity.dev) === binding.dev && Number(identity.ino) === binding.ino; } catch { return false; }
}
export function appendLog(home: string, request: LogRequest, options: { env?: NodeJS.ProcessEnv; now?: Date; binding?: LogBinding } = {}): LogReceipt {
  const result: LogReceipt = { ok: false, appended: false, synced: false, bytesWritten: 0, issues: [] };
  let fd: number | undefined, lockFd: number | undefined, lockFile: string | undefined, identity: { ino: number; dev: number } | undefined;
  const error = (code: string, message: string) => result.issues.push({ code, severity: "error", message });
  try {
    if (!request || typeof request !== "object" || typeof request.vault !== "string" || Object.keys(request).some(key => !["vault", "event", "channel"].includes(key))) refuse("L09", "invalid log request");
    // A bound append compares the registry first, so any re-registration reads as drift rather than a policy or path error.
    if (options.binding && !matchesBinding(loadRegistry(home), request.vault, options.binding)) refuse("LOG_DRIFT", "vault identity or policy changed after mutation; log not appended");
    let ctx: ReturnType<typeof context>;
    try { ctx = context(home, request.vault, request.channel, true); }
    catch (caught) {
      // A re-registration between the binding check and this second registry read still reads as drift.
      if (options.binding && !matchesBinding(loadRegistry(home), request.vault, options.binding)) refuse("LOG_DRIFT", "vault identity or policy changed after mutation; log not appended");
      throw caught;
    }
    const rootIdentity = lstatSync(ctx.vault.path);
    if (options.binding) {
      const bound = options.binding;
      if (JSON.stringify(ctx.vault) !== JSON.stringify(bound.vault) || rootIdentity.dev !== bound.dev || rootIdentity.ino !== bound.ino || JSON.stringify(ctx.config.denyPaths ?? []) !== JSON.stringify(bound.denyPaths) || JSON.stringify(ctx.config.piiPatterns ?? []) !== JSON.stringify(bound.piiPatterns)) refuse("LOG_DRIFT", "vault identity or policy changed after mutation; log not appended");
    }
    const formatted = formatLogEvent(request.event, { ...ctx, env: options.env ?? process.env, now: options.now });
    if (!formatted.line || formatted.issues.some(issue => issue.severity === "error")) { result.issues.push(...formatted.issues); return result; }
    result.issues.push(...formatted.issues); // nonblocking warnings (for example a log-surface PII warn cell)
    const buffer = Buffer.from(formatted.line), root = ctx.vault.path;
    lockFile = join(root, LOG_LOCK);
    const deadline = Date.now() + 2000, sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try { lockFd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
      catch (caught) {
        if ((caught as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) { lockFile = undefined; refuse("LOG_LOCKED", "log lock unavailable; existing lock is preserved"); }
        Atomics.wait(sleeper, 0, 0, 5);
      }
    }
    const lockStat = fstatSync(lockFd); identity = { ino: Number(lockStat.ino), dev: Number(lockStat.dev) };
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() }) + "\n");
    const stillRoot = lstatSync(root);
    if (stillRoot.dev !== rootIdentity.dev || stillRoot.ino !== rootIdentity.ino) refuse("LOG_DRIFT", "vault identity changed while acquiring log lock");
    const file = join(root, "log"); let existed = true;
    try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse("L09", "log must be a plain nonlinked file"); }
    catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught; existed = false; }
    fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) refuse("L09", "log must be a plain nonlinked file");
    if (before.size > 0) {
      const last = Buffer.alloc(1); if (readSync(fd, last, 0, 1, before.size - 1) !== 1 || last[0] !== 10) refuse("L09", "log ends in an incomplete line; inspect before appending");
    }
    let written: number;
    try { written = writeSync(fd, buffer, 0, buffer.length, null); result.bytesWritten = written; }
    catch {
      // Preserve unknown state unless a bounded read proves our entire append or prefix.
      result.appended = null; result.bytesWritten = null;
      const after = fstatSync(fd), linked = lstatSync(file), added = after.size - before.size;
      if (linked.ino === before.ino && linked.dev === before.dev && added >= 0 && added <= buffer.length) {
        const tail = Buffer.alloc(added);
        if (readSync(fd, tail, 0, tail.length, before.size) === tail.length && tail.equals(buffer.subarray(0, added))) {
          result.bytesWritten = added;
          if (added === buffer.length) result.appended = true;
          else {
            result.appended = false;
            if (added) { ftruncateSync(fd, before.size); fsyncSync(fd); result.rolledBack = true; }
          }
        }
      }
      refuse("LOG_WRITE", "log write failed; inspect append state before retrying");
    }
    if (written !== buffer.length) {
      const after = fstatSync(fd), linked = lstatSync(file);
      if (written >= 0 && after.size === before.size + written && linked.ino === before.ino && linked.dev === before.dev) {
        const tail = Buffer.alloc(written);
        if (readSync(fd, tail, 0, written, before.size) === written && tail.equals(buffer.subarray(0, written))) {
          ftruncateSync(fd, before.size); fsyncSync(fd); result.rolledBack = true;
        }
      }
      refuse("LOG_WRITE", "short log write refused; inspect rollback state before retrying");
    }
    result.appended = true;
    fsyncSync(fd);
    if (!existed) syncDirectory(root);
    let sameIdentity = false;
    try {
      const finalLog = lstatSync(file), finalRoot = lstatSync(root);
      sameIdentity = !finalLog.isSymbolicLink() && finalLog.ino === before.ino && finalLog.dev === before.dev && finalRoot.ino === rootIdentity.ino && finalRoot.dev === rootIdentity.dev;
    } catch { /* A removed path is drift, not proof that the fd's event is accessible. */ }
    if (!sameIdentity) {
      result.appended = null;
      refuse("LOG_DRIFT", "log or vault identity changed during append; current path persistence is unknown");
    }
    result.synced = true; result.ok = true;
  } catch (caught) {
    if (caught instanceof LogRefused) result.issues.push(...caught.issues);
    else error("LOG_IO", "log operation failed; inspect file permissions and append state");
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { error("LOG_CLOSE", "log descriptor close failed"); } }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { error("LOG_CLEANUP", "log lock descriptor close failed"); }
      try {
        const stat = lstatSync(lockFile!);
        if (stat.isSymbolicLink() || Number(stat.ino) !== identity?.ino || Number(stat.dev) !== identity?.dev) error("LOG_CLEANUP", "log lock ownership changed; retained lock");
        else unlinkSync(lockFile!);
      } catch { error("LOG_CLEANUP", "log lock retained; inspect before manual recovery"); }
    }
    if (result.issues.some(issue => issue.severity === "error")) result.ok = false;
  }
  return result;
}
/** Bounded-memory streaming tail/filter reader. It never creates a home, lock or log file. */
export function readLog(home: string, options: LogReadOptions): LogReadResult {
  const result: LogReadResult = { ok: false, lines: [], dataLines: null, warnings: [], issues: [] };
  let fd: number | undefined;
  try {
    if (!options || typeof options !== "object" || typeof options.vault !== "string" || Object.keys(options).some(key => !["vault", "limit", "grep", "type"].includes(key))) refuse("L09", "invalid log read options");
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) refuse("L09", "log limit must be an integer 1..200");
    if (options.type !== undefined && !(LOG_TYPES as readonly string[]).includes(options.type)) refuse("L09", "unknown log type filter");
    let filter: ((line: string) => boolean) | undefined;
    if (options.grep !== undefined) {
      if (typeof options.grep !== "string" || options.grep.length > 256) refuse("L09", "grep pattern exceeds 256 characters");
      try { filter = compileLogFilter(options.grep); } catch { refuse("L09", "invalid or unsupported bounded grep expression"); }
    }
    const ctx = context(home, options.vault, undefined, false), file = join(ctx.vault.path, "log");
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (caught) { if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { ...result, ok: true, dataLines: 0 }; throw caught; }
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse("L09", "log must be a plain file");
    if (stat.size > MAX_LOG_READ_BYTES) refuse("LOG_SIZE", "log exceeds 32 MiB read bound; archive manually");
    const decoder = new TextDecoder("utf-8", { fatal: true }), buffer = Buffer.alloc(64 * 1024);
    let pending = "", oversized = false, nonblank = false, comment: boolean | undefined, dataLines = 0, offset = 0, resultBytes = 2;
    const consume = (piece: string, end: boolean, incomplete = false) => {
      if (piece.trim()) nonblank = true;
      if (comment === undefined) { const leading = piece.trimStart(); if (leading) comment = leading.startsWith("#"); }
      if (!oversized) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(piece) > MAX_READ_LINE_BYTES) { oversized = true; pending = ""; }
        else pending += piece;
      }
      if (!end) return;
      if (nonblank && !comment) {
        dataLines++;
        if (incomplete || oversized) {
          const warning = incomplete ? "incomplete final log line omitted" : "historical log line over 4096 bytes omitted";
          if (!result.warnings.includes(warning)) result.warnings.push(warning);
        } else {
          const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
          const type = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+(\S+)/.exec(line)?.[1];
          if ((!options.type || options.type === type) && (!filter || filter(line))) {
            result.lines.push(line); resultBytes += Buffer.byteLength(JSON.stringify(line)) + 1;
            while (result.lines.length > limit || resultBytes > MAX_LOG_RESULT_BYTES) resultBytes -= Buffer.byteLength(JSON.stringify(result.lines.shift()!)) + 1;
          }
        }
      }
      pending = ""; oversized = false; nonblank = false; comment = undefined;
    };
    // Read a fixed descriptor snapshot; concurrent appends belong to the next call.
    while (offset < stat.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!count) refuse("LOG_READ", "log changed while reading");
      offset += count;
      const parts = decoder.decode(buffer.subarray(0, count), { stream: true }).split("\n");
      for (let i = 0; i < parts.length; i++) consume(parts[i]!, i < parts.length - 1);
    }
    const final = decoder.decode(); if (final) consume(final, false);
    if (pending || oversized || nonblank) consume("", true, true);
    if (dataLines > LARGE_LOG_LINES) result.warnings.push("log exceeds 20000 data lines; manual archival recommended");
    result.dataLines = dataLines; result.ok = true;
  } catch (caught) {
    result.lines = [];
    if (caught instanceof LogRefused) result.issues.push(...caught.issues);
    else result.issues.push({ code: "LOG_READ", severity: "error", message: "cannot read plain UTF-8 log" });
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { result.ok = false; result.issues.push({ code: "LOG_CLOSE", severity: "error", message: "log descriptor close failed" }); } }
  }
  return result;
}
