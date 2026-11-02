import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { absolute, type SpecSourceSpec } from "./config.ts";
import { realPath, memoryGitArgv, memoryGitEnv } from "./platform.ts";
import { VaultIndex, type IndexSourceAdapter, type SearchOptions, type SearchResult } from "./vault-index.ts";

/** Private spec input snapshot; raw sources are for library transforms, never graph results. */
export interface SpecDocument {
  id: string;
  path: string;
  hash: string;
  source: string;
  frontmatter: Record<string, unknown>;
  body: string;
}
export interface SpecDiagnostic {
  code: "duplicate_id" | "invalid_frontmatter" | "invalid_identity";
  path: string;
  id?: string;
  firstPath?: string;
  message: string;
}
export interface SpecSnapshot {
  root: string;
  commonDir: string;
  specs: SpecDocument[];
  diagnostics: SpecDiagnostic[];
}

export interface SpecSourceOptions { worktree?: string; env?: NodeJS.ProcessEnv }
export interface SpecIndexOptions extends SpecSourceOptions { memory?: boolean; reuseCache?: boolean; protectedRoots?: string[] }
export interface SpecSearchResult extends SearchResult { id: string }
interface Binding { root: string; registeredRoot: string; commonDir: string; env: NodeJS.ProcessEnv }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pathOrder = (a: string, b: string) => compare(a.normalize("NFC"), b.normalize("NFC")) || compare(a, b);
function git(root: string, args: string[], env: NodeJS.ProcessEnv, maxBuffer = 65536): Buffer {
  const argv = memoryGitArgv(["-C", root, ...args]);
  const result = spawnSync(argv[0]!, argv.slice(1), { env: memoryGitEnv({ ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, { repositoryIsolation: true }), timeout: 10000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new Error("spec source: git inspection timed out after 10000 ms; retry and check for a locked repository or slow mount");
    if (code === "ENOBUFS") throw new Error(`spec source: git output exceeded ${maxBuffer} bytes; reduce the Markdown discovery scope and retry`);
    throw new Error(`spec source: git could not run (${code ?? "spawn failure"}); install git or fix PATH before retrying`);
  }
  if (result.status !== 0) {
    const first = result.stderr.toString("utf8").split(/\r?\n/, 1)[0]?.split(root).join("<path>").slice(0, 240) || "no diagnostic";
    throw new Error(`spec source: git refused inspection (exit ${result.status ?? "signal"}): ${first}; inspect git -C <path> rev-parse --show-toplevel and repair the repository or ownership configuration`);
  }
  return result.stdout;
}
function rootInfo(path: string, env: NodeJS.ProcessEnv): { root: string; commonDir: string } {
  try { absolute(path, "spec worktree"); }
  catch { throw new Error("spec source: worktree must be an absolute path without control characters; pass the repository root"); }
  let root: string;
  try { root = realPath(path); } catch { throw new Error("spec source: worktree root is unavailable; restore the repository or select an existing worktree"); }
  // rev-parse has no NUL-output mode: root paths reject control characters, and exactly two lines are required.
  const lines = git(root, ["rev-parse", "--show-toplevel", "--git-common-dir"], env).toString("utf8").replace(/\n$/, "").split("\n");
  if (lines.length !== 2 || lines[0] !== root || !lines[1]) throw new Error("spec source: selected path is not a git working-tree root; select the root from git rev-parse --show-toplevel");
  let commonDir: string;
  try { commonDir = realPath(resolve(root, lines[1])); } catch { throw new Error("spec source: git common directory is unavailable; repair the repository before retrying"); }
  return { root, commonDir };
}
function bind(source: SpecSourceSpec, options: SpecSourceOptions): Binding {
  const env = options.env ?? process.env, registered = rootInfo(source.path, env);
  if (registered.root !== source.path) throw new Error("spec source: registered root is no longer canonical; re-register it with vmem specs add");
  const selected = options.worktree === undefined ? registered : rootInfo(options.worktree, env);
  if (selected.commonDir !== registered.commonDir) throw new Error("spec source: worktree belongs to another repository; select a worktree sharing the registered repository's git common directory");
  return { root: selected.root, registeredRoot: registered.root, commonDir: selected.commonDir, env };
}
export function resolveSpecWorktree(source: SpecSourceSpec, worktree?: string, env: NodeJS.ProcessEnv = process.env): string {
  return bind(source, { worktree, env }).root;
}
function validate(binding: Binding): void {
  const registered = rootInfo(binding.registeredRoot, binding.env), selected = rootInfo(binding.root, binding.env);
  if (registered.root !== binding.registeredRoot || selected.root !== binding.root || registered.commonDir !== binding.commonDir || selected.commonDir !== binding.commonDir) throw new Error("spec source: repository/worktree binding changed; resolve the registered source again before retrying");
}
/** Reject every symlink component. A path first selected as plain must stay plain throughout its read. */
function plainPath(root: string, path: string): boolean {
  const parts = path.split("/");
  if (!path.endsWith(".md") || isAbsolute(path) || parts.some(part => !part || part === "." || part === "..")) throw new Error("spec source: git returned an unsafe Markdown path; repair the index and retry discovery");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("spec source: Markdown path cannot be inspected; restore read access and retry discovery"); }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return false;
  }
  return realPath(current) === current && !relative(root, current).startsWith("../");
}
function adapter(binding: Binding) {
  let specs: SpecDocument[] = [], diagnostics: SpecDiagnostic[] = [];
  const seen = new Map<string, string>();
  const source: IndexSourceAdapter = {
    validate: () => validate(binding),
    paths: () => {
      specs = []; diagnostics = []; seen.clear();
      const bytes = git(binding.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], binding.env, 8 * 1024 * 1024);
      let output: string;
      try { output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error("spec source: Git paths are not valid UTF-8; repair the filenames before retrying discovery"); }
      if (output && !output.endsWith("\0")) throw new Error("spec source: git returned incomplete NUL-delimited paths; retry discovery on a stable repository");
      const paths = [...new Set(output.split("\0").filter(Boolean))].sort(pathOrder);
      if (paths.length > 10000) throw new Error("spec source: more than 10000 Markdown paths; reduce the repository discovery scope before rebuilding");
      return paths.filter(path => plainPath(binding.root, path));
    },
    validatePath: path => {
      if (!plainPath(binding.root, path)) throw new Error("spec source: selected Markdown path changed or became a symlink; restore a plain in-repository file and retry");
    },
    invalid: path => diagnostics.push({ code: "invalid_frontmatter", path, message: "spec source: invalid frontmatter; repair the Markdown YAML before rebuilding" }),
    accept: (path, document, hash) => {
      const data = document.data;
      if (!Object.hasOwn(data, "id") || !Object.hasOwn(data, "type")) return false;
      if (typeof data.id !== "string" || !data.id.trim() || typeof data.type !== "string" || !data.type.trim()) {
        diagnostics.push({ code: "invalid_identity", path, message: "spec source: id and type must be nonempty strings; repair the frontmatter before rebuilding" });
        return false;
      }
      const firstPath = seen.get(data.id);
      if (firstPath !== undefined) {
        diagnostics.push({ code: "duplicate_id", path, id: data.id, firstPath, message: "duplicate spec id; give each spec a unique frontmatter id before rebuilding" });
        return false;
      }
      seen.set(data.id, path);
      specs.push({ id: data.id, path, hash, source: document.source, frontmatter: data, body: document.body });
      return true;
    },
  };
  return { source, snapshot: (): SpecSnapshot => ({ root: binding.root, commonDir: binding.commonDir, specs: [...specs], diagnostics: [...diagnostics] }) };
}
/** Call scan() to refresh. Search and snapshots use the last completed scan, like VaultIndex. */
export class SpecIndex {
  private readonly index: VaultIndex<SpecSourceSpec>;
  private readonly adapter: ReturnType<typeof adapter>;
  private current?: SpecSnapshot;
  constructor(home: string, source: SpecSourceSpec, options: SpecIndexOptions = {}) {
    const binding = bind(source, options);
    this.adapter = adapter(binding);
    try {
      this.index = new VaultIndex(home, { ...source, path: binding.root }, [...new Set([source.path, binding.root, ...(options.protectedRoots ?? [])])], { memory: options.memory, reuseCache: options.reuseCache, adapter: this.adapter.source });
    } catch (error) { throw new Error(`spec index: ${error instanceof Error ? error.message : "cache initialization failed"}; choose a readable plain cache directory outside protected sources and retry`); }
  }
  get file(): string { return this.index.file; }
  close(): void { this.index.close(); }
  scan(rebuild = false): ReturnType<VaultIndex["scan"]> {
    try {
      const result = this.index.scan(rebuild);
      this.current = this.adapter.snapshot();
      return result;
    } catch (error) { throw new Error(`spec scan: ${error instanceof Error ? error.message : "scan failed"}; restore a stable, readable worktree and retry scan`); }
  }
  snapshot(): SpecSnapshot { if (!this.current) this.scan(); return this.current!; }
  search(query: string, options: SearchOptions = {}): SpecSearchResult[] {
    const snapshot = this.snapshot(), ids = new Map(snapshot.specs.map(spec => [spec.path, spec.id]));
    return this.index.search(query, options).map(hit => ({ ...hit, id: ids.get(hit.path)! }));
  }
}
/** One-shot discovery is in memory and never opens or creates a cache on disk. */
export function discoverSpecs(source: SpecSourceSpec, options: SpecSourceOptions = {}): SpecSnapshot {
  const index = new SpecIndex(tmpdir(), source, { ...options, memory: true, reuseCache: false, protectedRoots: [] });
  try { index.scan(); return index.snapshot(); } finally { index.close(); }
}
