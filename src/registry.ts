import { closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_FILE, MAX_CONFIG_BYTES, parseConfig, parsePii, parseVault, readConfig, type VaultSpec, type VmemConfig } from "./config.ts";
import { loosenedCells, piiPolicy, piiShorthand } from "./pii.ts";
export const LOCK_FILE = "config.lock";
const TEMP = /^\.config-[0-9a-f-]{36}\.tmp$/;
export interface LockOwner { pid: number; host: string; created: string }
export function loadRegistry(home: string): VmemConfig {
  const config = readConfig(home);
  if (config.home) throw new Error(`${join(home, CONFIG_FILE)}: redirected home cannot contain another home pointer`);
  return config;
}
/** Effective pii shorthand (`custom` for a mixed policy); the full matrix is `piiPolicy`. */
export function effectivePii(vault: VaultSpec): "allow" | "warn" | "deny" | "custom" { return piiShorthand(vault); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/**
 * Directory fsync makes the rename durable on Linux. On macOS fsync(2) on a directory
 * succeeds but does not force the drive cache (no F_FULLFSYNC); Windows cannot open
 * directories for fsync, so the rename is atomic but durability is left to the OS there.
 */
export function syncDirectory(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); return true; } finally { closeSync(fd); }
}
function mutate<T>(home: string, update: (config: VmemConfig) => T): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  let lockFd: number;
  try { lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${lock}: registry is locked by another writer; run \`vmem recover\` if no writer is running`, { cause: error });
    throw new Error(`${lock}: cannot create registry lock`, { cause: error });
  }
  let temporary: string | undefined;
  let primary: unknown;
  let failed = false;
  try {
    const owner: LockOwner = { pid: process.pid, host: hostname(), created: new Date().toISOString() };
    writeFileSync(lockFd, JSON.stringify(owner) + "\n");
    const config = loadRegistry(home), result = update(config);
    parseConfig(config);
    const text = JSON.stringify(config, null, 2) + "\n";
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error(`${join(home, CONFIG_FILE)}: serialized config exceeds 64 KiB`);
    const candidate = join(home, `.config-${randomUUID()}.tmp`);
    const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    temporary = candidate;
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(home, CONFIG_FILE));
    temporary = undefined;
    try { syncDirectory(home); }
    catch (error) { throw new Error(`${join(home, CONFIG_FILE)}: registry updated but directory fsync failed: ${message(error)}`, { cause: error }); }
    return result;
  } catch (error) {
    failed = true; primary = error;
    throw error;
  } finally {
    // Each cleanup is independent: a temp cleanup error must not strand our lock.
    const cleanupErrors: string[] = [];
    for (const [label, cleanup] of [
      ["temporary file", () => { if (temporary) unlinkSync(temporary); }],
      ["lock descriptor", () => closeSync(lockFd)],
      [`lock retained at ${lock}`, () => unlinkSync(lock)],
    ] as const) {
      try { cleanup(); } catch (error) { cleanupErrors.push(`${label}: ${message(error)}`); }
    }
    if (cleanupErrors.length) {
      const note = `cleanup failed (${cleanupErrors.join("; ")})`;
      // Keep the primary error as the thrown error and add the cleanup failure to it.
      if (failed && primary instanceof Error) primary.message = `${primary.message}; ${note}`;
      else if (!failed) throw new Error(`${home}: registry updated but ${note}`);
    }
  }
}
/** Upper bound for a lock owner record; larger files are treated as unreadable. */
const MAX_LOCK_BYTES = 4096;
function lockOwner(lock: string): LockOwner | undefined {
  try {
    const fd = openSync(lock, constants.O_RDONLY);
    let text: string;
    try {
      const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
      let length = 0, read: number;
      while (length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
      if (length > MAX_LOCK_BYTES) return undefined; // oversized: never trusted
      text = buffer.subarray(0, length).toString("utf8");
    } finally { closeSync(fd); }
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && typeof value.host === "string" && typeof value.created === "string") return value as LockOwner;
  } catch { /* unreadable or legacy lock */ }
  return undefined;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export interface RecoveryReport {
  applied: boolean;
  lock: { path: string; state: "absent" | "live" | "stale" | "unknown"; owner?: LockOwner; removed: boolean };
  temporaryFiles: string[];
  removedTemporaryFiles: string[];
  blocked?: string;
}
/**
 * Crash recovery. Preview unless confirm. A lock is stale only when its owner record names this host
 * and a pid that no longer exists; live, foreign-host and unreadable locks are never removed.
 * Leftover `.config-<uuid>.tmp` files are removed only when no live or unknown lock is held.
 */
export function recoverRegistry(home: string, confirm = false): RecoveryReport {
  const path = join(home, LOCK_FILE);
  let entries: string[] = [];
  try { entries = readdirSync(home); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${home}: cannot list registry home`, { cause: error }); }
  const temporaryFiles = entries.filter(name => TEMP.test(name)).sort();
  const report: RecoveryReport = { applied: false, lock: { path, state: "absent", removed: false }, temporaryFiles, removedTemporaryFiles: [] };
  if (entries.includes(LOCK_FILE)) {
    const owner = lockOwner(path);
    if (owner) report.lock.owner = owner;
    report.lock.state = !owner || owner.host !== hostname() ? "unknown" : alive(owner.pid) ? "live" : "stale";
  }
  if (report.lock.state === "live" || report.lock.state === "unknown") {
    report.blocked = report.lock.state === "live" ? "a live writer holds the lock" : "lock owner cannot be verified on this host; confirm no writer runs, then remove the lock manually";
    return report;
  }
  if (!confirm) return report;
  report.applied = true;
  if (report.lock.state === "stale") {
    // Re-check immediately before removal to narrow the window against a new writer.
    const again = lockOwner(path);
    if (!again || again.pid !== report.lock.owner?.pid || again.created !== report.lock.owner.created) { report.applied = false; report.blocked = "lock changed during recovery"; return report; }
    unlinkSync(path); report.lock.removed = true;
  }
  for (const name of temporaryFiles) {
    try { unlinkSync(join(home, name)); report.removedTemporaryFiles.push(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${join(home, name)}: cannot remove temporary file`, { cause: error }); }
  }
  return report;
}
export function addVault(home: string, value: unknown): VaultSpec {
  const vault = parseVault(value);
  try { vault.path = realpathSync(vault.path); }
  catch (error) { throw new Error(`vault ${vault.id}: path ${vault.path} is unavailable`, { cause: error }); }
  const notes = join(vault.path, "notes");
  let isDir = false;
  try { isDir = statSync(notes).isDirectory(); } catch { /* reported below */ }
  if (!isDir) throw new Error(`vault ${vault.id}: ${vault.path} must contain notes directory`);
  if (realpathSync(notes) !== notes) throw new Error(`vault ${vault.id}: ${notes} must not be a symlink`);
  return mutate(home, config => {
    if (config.vaults.some(v => v.id === vault.id)) throw new Error(`vault ${vault.id}: id already registered`);
    if (config.vaults.some(v => {
      if (v.path === vault.path) return true;
      try { return realpathSync(v.path) === vault.path; }
      catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    })) throw new Error(`vault ${vault.id}: path ${vault.path} already registered`);
    config.vaults.push(vault);
    return vault;
  });
}
export function removeVault(home: string, id: string, confirm = false): { applied: boolean; vault: VaultSpec } {
  const remove = (config: VmemConfig) => {
    const vault = config.vaults.find(v => v.id === id);
    if (!vault) throw new Error(`${join(home, CONFIG_FILE)}: unknown vault id ${id}`);
    if (confirm) config.vaults = config.vaults.filter(v => v.id !== id);
    return { applied: confirm, vault };
  };
  return confirm ? mutate(home, remove) : remove(loadRegistry(home));
}
/** Show or change a vault's PII policy. Without `confirm` it previews; loosened cells are listed either way. */
export function setVaultPii(home: string, id: string, value: unknown, confirm = false) {
  const next = value === undefined ? undefined : parsePii(value);
  const change = (config: VmemConfig) => {
    const vault = config.vaults.find(v => v.id === id);
    if (!vault) throw new Error(`${join(home, CONFIG_FILE)}: unknown vault id ${id}`);
    const before = piiPolicy(vault);
    if (next === undefined) return { vault: id, pii: piiShorthand(vault), piiPolicy: before };
    const updated: VaultSpec = { ...vault, pii: next }, after = piiPolicy(updated);
    const loosened = loosenedCells(before, after), changed = JSON.stringify(before) !== JSON.stringify(after);
    if (confirm && changed) vault.pii = next;
    return { vault: id, applied: confirm && changed, changed, loosened, pii: piiShorthand(updated), piiPolicy: after, ...(confirm ? {} : { preview: true }) };
  };
  return confirm && next !== undefined ? mutate(home, change) : change(loadRegistry(home));
}
export function registryStatus(home: string) {
  const config = loadRegistry(home);
  return config.vaults.map(vault => {
    const base = { ...vault, pii: effectivePii(vault), piiPolicy: piiPolicy(vault) };
    try {
      const root = realpathSync(vault.path), notes = join(root, "notes");
      if (root !== vault.path || realpathSync(notes) !== notes || !statSync(notes).isDirectory()) throw new Error("changed");
      return { ...base, healthy: true };
    } catch { return { ...base, healthy: false, issue: "vault path or notes directory unavailable or changed" }; }
  });
}
