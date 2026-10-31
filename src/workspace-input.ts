import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { VaultSpec, VmemConfig } from "./config.ts";
import type { AnalysisSnapshot } from "./analysis-types.ts";
import { analysisRead } from "./analysis-input.ts";
import { parseAnalysisYaml } from "./analysis-yaml.ts";
import { isDenied } from "./platform.ts";
import { sourceWorkspaceRoot } from "./source.ts";
import { WORK_SKIP_DIRS, workspaceFrontmatter, workspaceSource, workSkipped, type WorkspaceSnapshot } from "./workspace-graph.ts";

const CONFIG_SKIP = new Set([".git", "node_modules", ".venv", ".sync-conflicts", "archive", ".archive", "vault", "temp"]);
export const WORK_MAX_FILES = 10000;
export const WORK_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const WORK_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_ROOTS = ["scratchpad/memos", "scratchpad/temp"];
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Filesystem-only snapshot. No directory or file symlinks are followed, including source stubs. */
export function workspaceInput(snapshot: AnalysisSnapshot, vault: VaultSpec, config: VmemConfig): WorkspaceSnapshot {
  const found = sourceWorkspaceRoot(vault);
  if (!found) throw new Error("workspace graph: vault requires a registry");
  const root = realpathSync(found);
  if (root !== found || lstatSync(found).isSymbolicLink() || !lstatSync(found).isDirectory()) throw new Error("workspace graph: work root must be a plain directory");
  const denied = (file: string) => isDenied(file, config.denyPaths ?? []);
  if (denied(root)) throw new Error("workspace graph: work root is denied");
  let filesRead = 0, bytesRead = 0, entriesSeen = 0;
  const stamps = new Map<string, string>();
  const stamp = (file: string) => { const stat = lstatSync(file, { bigint: true }); return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":"); };
  const remember = (file: string) => {
    const current = stamp(file), prior = stamps.get(file);
    if (prior !== undefined && prior !== current) throw new Error("workspace graph: input changed during snapshot");
    stamps.set(file, current);
  };
  const read = (file: string, maximum = WORK_MAX_FILE_BYTES): string => {
    if (++filesRead > WORK_MAX_FILES) throw new Error("workspace graph: file count exceeds bound");
    remember(file);
    const text = analysisRead(file, maximum);
    if (text === null) throw new Error("workspace graph: input disappeared");
    remember(file);
    bytesRead += Buffer.byteLength(text);
    if (bytesRead > WORK_MAX_TOTAL_BYTES) throw new Error("workspace graph: total bytes exceed bound");
    return text;
  };
  let skipRoots = DEFAULT_ROOTS;
  const workspaceConfig = join(root, "workspace.config.yaml");
  try {
    const stat = lstatSync(workspaceConfig);
    if (stat.isFile() && !stat.isSymbolicLink() && !denied(workspaceConfig)) {
      const text = read(workspaceConfig, 1024 * 1024);
      let data: Record<string, unknown> = {};
      try { data = object(parseAnalysisYaml(text)); } catch { /* Reference falls back on malformed config. */ }
      const paths = object(data.paths), scratchpad = object(data.scratchpad), configured = String(paths.scratchpad ?? "").trim();
      let scratchRoot = "scratchpad";
      if (configured) {
        const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
        const absolute = resolve(expanded), rel = relative(root, absolute);
        if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)) scratchRoot = rel.normalize("NFC").replace(/^\/+|\/+$/g, "");
        else scratchRoot = "";
      }
      if (scratchRoot) skipRoots = [String(scratchpad.memos_subdir || "memos"), String(scratchpad.temp_subdir || "temp")].map(dir => scratchRoot + "/" + dir.normalize("NFC").replace(/^\/+|\/+$/g, ""));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const walk = (dir: string, skip: Set<string>, roots: string[], visit: (file: string, rel: string) => void): void => {
    if (realpathSync(dir) !== dir || denied(dir)) return;
    remember(dir);
    const handle = opendirSync(dir), children: { name: string; directory: boolean; file: boolean }[] = [];
    try {
      for (;;) {
        const entry = handle.readSync(); if (!entry) break;
        if (++entriesSeen > 200000) throw new Error("workspace graph: directory entry count exceeds bound");
        if (entry.isSymbolicLink()) continue;
        children.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
      }
    } finally { handle.closeSync(); }
    for (const entry of children) {
      const file = join(dir, entry.name);
      if (entry.file && !denied(file)) visit(file, relative(root, file).normalize("NFC"));
    }
    for (const entry of children) {
      const file = join(dir, entry.name), rel = relative(root, file).normalize("NFC");
      if (entry.directory && !skip.has(entry.name) && !workSkipped(rel, roots) && !denied(file)) walk(file, skip, roots, visit);
    }
    remember(dir);
  };
  const files: WorkspaceSnapshot["files"] = [], buSlugs = new Set<string>();
  walk(root, WORK_SKIP_DIRS, skipRoots, (file, path) => { if (path.endsWith(".md")) files.push({ path, text: read(file) }); });
  walk(root, CONFIG_SKIP, [], (file, path) => {
    if (!path.endsWith("/bu-config.yaml") && path !== "bu-config.yaml") return;
    const text = read(file, 1024 * 1024);
    try {
      const data = object(parseAnalysisYaml(text)), slug = String(data.bu_id ?? "").replaceAll("[[", "").replaceAll("]]", "").trim();
      if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) buSlugs.add(slug);
    } catch { /* Invalid bu config does not declare a hub. */ }
  });
  const plain = (candidate: string): "file" | "directory" | "missing" | "denied" => {
    const rel = relative(root, candidate);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return "missing";
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if (denied(current)) return "denied";
      try { const stat = lstatSync(current); if (stat.isSymbolicLink()) return "missing"; remember(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return "missing"; throw error; }
    }
    const stat = lstatSync(candidate);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "missing";
  };
  const sourceTargets: WorkspaceSnapshot["sourceTargets"] = {};
  for (const note of snapshot.notes) {
    const raw = workspaceSource(workspaceFrontmatter(note.source));
    if (raw === undefined) continue;
    const norm = raw.endsWith(".md") ? raw.slice(0, -3) : raw;
    if (norm.split("/").some(part => WORK_SKIP_DIRS.has(part)) || workSkipped(norm, skipRoots)) continue;
    const file = plain(resolve(root, norm + ".md"));
    sourceTargets[norm] = file === "file" || file === "denied" ? file : plain(resolve(root, norm)) === "directory" ? "directory" : "missing";
  }
  const assertUnchanged = () => { for (const [file, expected] of stamps) if (stamp(file) !== expected) throw new Error("workspace graph: input changed during build"); };
  assertUnchanged();
  return { files, buSlugs: [...buSlugs].sort(), skipRoots, sourceTargets, assertUnchanged };
}
