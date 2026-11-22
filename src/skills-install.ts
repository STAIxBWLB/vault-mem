/** Install package-owned skills without replacing foreign or locally modified trees. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { version } from "../package.json";
import type { SetupMode, SetupTarget } from "./setup.ts";
import { shellWord } from "./text-output.ts";

export const SKILL_NAMES = ["vault-connect", "vault-enrich", "vault-extract", "vault-graph", "vault-learn", "vault-lint", "vault-refactor", "vault-remember", "vault-rethink", "vault-stats", "vault-sync", "vault-update", "vmem-status", "skill-mine"] as const;
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MARKER = ".vmem-skill.json", MAX_FILE = 2 * 1024 * 1024, MAX_BYTES = 16 * 1024 * 1024, MAX_FILES = 512;
export interface SkillAction { name: string; path: string; change: "install" | "replace" | "remove" | "unchanged" | "absent" | "modified" | "foreign" | "refused"; reason?: string }
export interface SkillInstallReport { root: string; actions: SkillAction[] }
interface Marker { tool: "vmem"; version: string; sha256: string }
type Files = Map<string, Uint8Array>;
function safePath(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function boundedFile(file: string, remaining: number): Uint8Array {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error("skill file is missing, unreadable or linked; inspect the skill directory"); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_FILE || before.size > remaining) throw new Error("skill file exceeds its read bound or is not regular; inspect the skill directory");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    const after = fstatSync(fd), named = lstatSync(file);
    if (named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || after.dev !== named.dev || after.ino !== named.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== before.size) throw new Error("skill file changed during inspection; stop concurrent edits and retry");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function walk(root: string): Files {
  const files: Files = new Map(); let total = 0, count = 0;
  const visit = (dir: string) => {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir) throw new Error("skill contains a linked or non-directory path; inspect the skill directory");
    const entries = opendirSync(dir); let children = 0;
    try {
      let entry: ReturnType<typeof entries.readSync>;
      while ((entry = entries.readSync()) !== null) {
        if (++count > MAX_FILES) throw new Error("skill contains too many entries; inspect the skill directory");
        const path = join(dir, entry.name), rel = relative(root, path).split(sep).join("/");
        if (!safePath(root, path) || entry.name === "." || entry.name === "..") throw new Error("skill contains an unsafe path; inspect the skill directory");
        if (rel === MARKER) continue;
        children++;
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) { const data = boundedFile(path, MAX_BYTES - total); total += data.length; files.set(rel, data); }
        else throw new Error("skill contains a link or special file; inspect the skill directory");
      }
    } finally { entries.closeSync(); }
    if (dir !== root && children === 0) throw new Error("skill contains an unexpected empty directory; inspect the skill directory");
    const after = lstatSync(dir);
    if (!identical(stat, after) || realpathSync(dir) !== dir) throw new Error("skill directory changed during inspection; stop concurrent edits and retry");
  };
  visit(root); return files;
}
function digest(files: Files): string {
  const hash = createHash("sha256");
  for (const [name, data] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) { hash.update(`${Buffer.byteLength(name)}:${name}:${data.length}:`); hash.update(data); }
  return hash.digest("hex");
}
function packaged(name: string, packageRoot: string): Files {
  const root = join(packageRoot, "skills", name);
  let files: Files, adapter: Uint8Array;
  try { files = walk(root); adapter = boundedFile(join(packageRoot, "skills", "_shared", "vault-adapter.md"), MAX_FILE); }
  catch (error) { throw new Error(`packaged skill ${name} is unavailable or invalid; reinstall a complete vmem package`, { cause: error }); }
  if (!files.has("SKILL.md") || files.has("references/vault-adapter.md")) throw new Error("packaged skill is missing its entry or contains a conflicting adapter; reinstall vmem");
  files.set("references/vault-adapter.md", adapter);
  const dirs = new Set<string>(); let bytes = 0;
  for (const [name, data] of files) {
    bytes += data.length;
    const parts = name.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  if (bytes > MAX_BYTES || files.size + dirs.size + 1 > MAX_FILES) throw new Error("packaged skill with its adapter exceeds installation bounds; reinstall a valid vmem package");
  return files;
}
function marker(path: string): Marker | undefined {
  try {
    const data: unknown = JSON.parse(Buffer.from(boundedFile(join(path, MARKER), 4096)).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const m = data as Record<string, unknown>;
    return Object.keys(m).sort().join(",") === "sha256,tool,version" && m.tool === "vmem" && typeof m.version === "string" && m.version.length <= 128 && typeof m.sha256 === "string" && /^[a-f0-9]{64}$/.test(m.sha256) ? m as unknown as Marker : undefined;
  } catch { return undefined; }
}
/** Atomic no-replace and directory exchange. Unsupported kernels or filesystems are refused. */
function renameAtomic(from: string, to: string, exchange: boolean): void {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("atomic skill rename is unsupported on this platform; use vmem skills export on a supported host");
  const fromBytes = Buffer.alloc(Buffer.byteLength(from) + 1), toBytes = Buffer.alloc(Buffer.byteLength(to) + 1);
  fromBytes.write(from); toBytes.write(to);
  let result: number;
  try {
  if (process.platform === "darwin") {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
    try { result = lib.symbols.renamex_np(ptr(fromBytes), ptr(toBytes), exchange ? 2 : 4); } finally { lib.close(); }
  } else {
    const lib = dlopen("libc.so.6", { renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
    try { result = lib.symbols.renameat2(-100, ptr(fromBytes), -100, ptr(toBytes), exchange ? 2 : 1); } finally { lib.close(); }
  }
  } catch (error) { throw new Error("atomic skill rename is unavailable; inspect platform and filesystem support before retrying", { cause: error }); }
  if (result !== 0) throw new Error("atomic skill rename failed or target changed; inspect the skill root and retry on a supported filesystem");
}
function identical(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink(); }
function stage(root: string, files: Files, digestValue: string, packageVersion: string): string {
  const dir = join(root, `.vmem-skill-${randomUUID()}`); mkdirSync(dir, { mode: 0o700 });
  try {
    for (const [name, bytes] of files) {
      const file = join(dir, name); if (!safePath(dir, file)) throw new Error("packaged skill has an unsafe path; reinstall vmem");
      mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 }); writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(join(dir, MARKER), JSON.stringify({ tool: "vmem", version: packageVersion, sha256: digestValue }) + "\n", { flag: "wx", mode: 0o600 });
    return dir;
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}
function existingRoot(path: string): string | undefined {
  try { const info = lstatSync(path); if (info.isSymbolicLink()) throw new Error(`skill root link points to ${readlinkSync(path)}; vmem installs only into a real directory or a link to the host's default skill root`); if (!info.isDirectory()) throw new Error("skill root is not a directory; choose a real directory"); return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.startsWith("skill root ")) throw error;
    throw new Error("skill root cannot be inspected; check its path and permissions", { cause: error });
  }
}
/** Re-walk a moved-aside tree and delete it only while it still matches `sha`; false keeps it for inspection. */
function removeVerified(path: string, sha: string): boolean {
  try { if (digest(walk(path)) !== sha) return false; rmSync(path, { recursive: true }); return true; }
  catch { return false; }
}
/** Plan or install one complete skill tree per name. `root` must be an absolute target directory. */
export function installSkills(root: string, mode: SetupMode, packageRoot = PACKAGE_ROOT, packageVersion = version, retryCommand = ["vmem", "skills", "export", root].map(shellWord).join(" "), rootGuard?: () => void): SkillInstallReport {
  if (!isAbsolute(root)) throw new Error("skills: target must be absolute; provide an absolute skill root");
  if (mode !== "undo" && (typeof packageVersion !== "string" || !packageVersion.trim() || Buffer.byteLength(packageVersion) > 128 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(packageVersion))) throw new Error("skills: package version is invalid; reinstall a valid vmem package");
  const requested = resolve(root), actions: SkillAction[] = [];
  rootGuard?.();
  let actual = existingRoot(requested);
  if (!actual && mode !== "dry-run" && mode !== "undo") { rootGuard?.(); mkdirSync(requested, { recursive: true, mode: 0o700 }); actual = existingRoot(requested); }
  if (!actual && mode === "apply") throw new Error("skills: target directory could not be created; inspect the target and retry");
  for (const name of SKILL_NAMES) {
    const target = join(actual ?? requested, name), action: SkillAction = { name, path: target, change: "absent" }; actions.push(action);
    try {
      let before: Stats | undefined;
      try { before = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (before && (!before.isDirectory() || before.isSymbolicLink())) { action.change = "foreign"; action.reason = mode === "undo" ? `not a vmem-owned real directory; left untouched. Remove it by hand or keep it` : `not a vmem-owned real directory; left untouched. Remove or relocate it and rerun ${retryCommand} to let vmem manage it, or keep it`; continue; }
      const own = before ? marker(target) : undefined;
      if (before && !own) { action.change = "foreign"; action.reason = mode === "undo" ? `ownership marker missing or invalid; left untouched. Remove it by hand or keep it` : `ownership marker missing or invalid; left untouched. Remove or relocate it and rerun ${retryCommand} to let vmem manage it, or keep it`; continue; }
      if (before && own) {
        let current: string;
        try { current = digest(walk(target)); } catch { action.change = "modified"; action.reason = mode === "undo" ? `contents cannot be safely verified; left untouched. Remove it by hand, or restore it and rerun ${retryCommand}` : `contents cannot be safely verified; left untouched. Inspect or remove it and rerun ${retryCommand}, or keep it`; continue; }
        if (current !== own.sha256) { action.change = "modified"; action.reason = mode === "undo" ? `contents differ from the ownership marker; left untouched. Remove it by hand, or restore it and rerun ${retryCommand}` : `contents differ from the ownership marker; left untouched. Restore or remove it and rerun ${retryCommand}, or keep the local edit`; continue; }
      }
      if (mode === "undo") {
        if (!before) continue;
        rootGuard?.();
        action.change = "remove";
        const moved = join(actual!, `.vmem-skill-${randomUUID()}`);
        renameAtomic(target, moved, false);
        let verified = false;
        try { verified = identical(before, lstatSync(moved)) && digest(walk(moved)) === own!.sha256; } catch { /* Restore an unverifiable tree. */ }
        if (!verified) {
          try { renameAtomic(moved, target, false); }
          catch { throw new Error(`skill changed during undo; inspect ${target} and ${moved} and restore the original manually`); }
          throw new Error("skill changed during undo; inspect the skill root before retrying");
        }
        if (!removeVerified(moved, own!.sha256)) action.reason = `removed but the moved-aside tree changed before deletion or cleanup failed; inspect ${moved} before retrying`;
        continue;
      }
      const files = packaged(name, packageRoot), sha = digest(files);
      if (before && own?.sha256 === sha && own.version === packageVersion) { action.change = "unchanged"; continue; }
      action.change = before ? "replace" : "install";
      if (mode === "dry-run") continue;
      rootGuard?.();
      const temp = stage(actual!, files, sha, packageVersion), staged = lstatSync(temp);
      let preserve = false, published = false;
      try {
        rootGuard?.();
        if (!before) { renameAtomic(temp, target, false); published = true; }
        else {
          if (!identical(before, lstatSync(target))) throw new Error("skill changed before replacement; inspect it and retry");
          renameAtomic(temp, target, true); published = true;
          let verified = false;
          try { verified = identical(before, lstatSync(temp)) && digest(walk(temp)) === own!.sha256 && identical(staged, lstatSync(target)); } catch { /* Restore an unverifiable tree. */ }
          if (!verified) {
            try { if (!identical(staged, lstatSync(target))) throw new Error("target changed"); renameAtomic(temp, target, true); published = false; }
            catch { preserve = true; }
            // The swap-back failed with the new tree published: neither tree is known good, so this is a failure.
            if (published) { action.change = "refused"; action.reason = `replacement outcome needs inspection; inspect ${target} and ${temp} before retrying`; continue; }
            throw new Error("skill changed during replacement; inspect it and retry");
          }
        }
      } finally {
        if (!preserve) {
          // The moved-aside old tree is deleted only if it still matches its marker right before removal.
          if (published && before) { if (!removeVerified(temp, own!.sha256)) action.reason = `installed, but the previous tree changed before deletion or cleanup failed; inspect ${temp}`; }
          else try { rmSync(temp, { recursive: true, force: true }); }
          catch (error) { if (published) action.reason = `installed but cleanup failed; inspect ${temp}`; else throw error; }
        }
      }
    } catch (error) { action.change = "refused"; action.reason = error instanceof Error ? error.message : "skill operation failed; inspect the skill root and retry"; }
  }
  return { root: actual ?? requested, actions };
}
export function skillRoot(target: SetupTarget, env: NodeJS.ProcessEnv): string | undefined {
  const map: Partial<Record<SetupTarget, [string, string]>> = { claude: ["CLAUDE_CONFIG_DIR", ".claude"], codex: ["CODEX_HOME", ".codex"], kimi: ["KIMI_CODE_HOME", ".kimi-code"], qwen: ["QWEN_HOME", ".qwen"] };
  const spec = map[target]; if (!spec) return undefined;
  const value = env[spec[0]]?.trim(), home = env.HOME?.trim() || homedir();
  if (value && !isAbsolute(value)) throw new Error(`setup: ${spec[0]} must be absolute; set an absolute host configuration directory`);
  return join(value ? resolve(value) : join(home, spec[1]), "skills");
}

/** Only an override profile may link its skill root to that host's real default root. */
export function resolveHostSkillRoot(target: SetupTarget, env: NodeJS.ProcessEnv): { root: string; linkedFrom?: string; recheck?: () => void } | { reason: string } | undefined {
  const requested = skillRoot(target, env);
  if (!requested) return undefined;
  let info: Stats;
  try { info = lstatSync(requested); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: requested }; throw error; }
  if (!info.isSymbolicLink()) return { root: requested };
  let targetText: string;
  try { targetText = readlinkSync(requested); }
  catch (error) { throw new Error("skill root link cannot be inspected; check its path and permissions", { cause: error }); }
  const skipped = () => ({ reason: `skill root links to ${targetText}, which vmem does not manage; skills not installed; use vmem skills export <dir> to install them elsewhere` });
  const vars: Partial<Record<SetupTarget, string>> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", kimi: "KIMI_CODE_HOME", qwen: "QWEN_HOME" };
  const variable = vars[target];
  if (!variable || !env[variable]?.trim()) return skipped();
  const defaults = { ...env }; delete defaults[variable];
  const defaultRoot = skillRoot(target, defaults)!;
  let defaultInfo: Stats, actual: string;
  try {
    defaultInfo = lstatSync(defaultRoot);
    if (!defaultInfo.isDirectory() || defaultInfo.isSymbolicLink()) return skipped();
    actual = realpathSync(defaultRoot);
    if (realpathSync(requested) !== actual) return skipped();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return skipped();
    throw new Error("skill root link cannot be inspected; check its path and permissions", { cause: error });
  }
  const recheck = () => {
    try {
      const link = lstatSync(requested), current = lstatSync(defaultRoot);
      if (!link.isSymbolicLink() || link.dev !== info.dev || link.ino !== info.ino || readlinkSync(requested) !== targetText || !identical(defaultInfo, current) || realpathSync(defaultRoot) !== actual || realpathSync(requested) !== actual) throw new Error();
    } catch {
      let target = targetText;
      try { target = readlinkSync(requested); } catch { /* Keep the last observed target when the link disappeared. */ }
      throw new Error(`skill root link changed (target ${target}); inspect ${requested} before retrying`);
    }
  };
  return { root: actual, linkedFrom: requested, recheck };
}

/** Export into a dedicated directory. Unknown entries mean it is not a vmem export root. */
export function exportSkills(destination: string): SkillInstallReport {
  if (typeof destination !== "string" || !destination.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(destination)) throw new Error("skills export: destination is missing or invalid; choose a directory path");
  const root = resolve(destination), existing = existingRoot(root);
  if (existing) {
    const entries = opendirSync(existing);
    try { let entry: ReturnType<typeof entries.readSync>; while ((entry = entries.readSync()) !== null) if (!(SKILL_NAMES as readonly string[]).includes(entry.name)) throw new Error("skills export: destination contains foreign entries; choose an empty directory or an existing vmem export"); }
    finally { entries.closeSync(); }
  }
  return installSkills(root, "apply");
}
