import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { absolute, type SpecSourceSpec } from "./config.ts";
import { realPath } from "./platform.ts";
import { specGit } from "./spec-git.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { VaultIndex, IndexCacheError, type IndexSourceAdapter, type SearchOptions, type SearchResult } from "./vault-index.ts";

/** Private spec input snapshot; raw sources are for library transforms, never graph results. */
export interface SpecCandidate {
  path: string;
  hash: string;
  source: string;
  frontmatter: Record<string, unknown>;
  body: string;
}
export interface SpecDocument extends SpecCandidate { id: string }
export interface SpecDiagnostic {
  code: "duplicate_id" | "invalid_frontmatter" | "invalid_identity" | "skipped_path" | "wrong_shape";
  path: string;
  id?: string;
  firstPath?: string;
  field?: string;
  message: string;
}
export interface SpecSnapshot {
  root: string;
  commonDir: string;
  specs: SpecDocument[];
  candidates?: SpecCandidate[];
  diagnostics: SpecDiagnostic[];
}

export interface SpecSourceOptions { worktree?: string; env?: NodeJS.ProcessEnv }
export interface SpecIndexOptions extends SpecSourceOptions { memory?: boolean; reuseCache?: boolean; protectedRoots?: string[] }
export interface SpecSearchResult extends SearchResult { id: string }
interface Binding { root: string; registeredRoot: string; commonDir: string; rootIdentity: string; env: NodeJS.ProcessEnv }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pathOrder = (a: string, b: string) => compare(a.normalize("NFC"), b.normalize("NFC")) || compare(a, b);
function git(root: string, args: string[], env: NodeJS.ProcessEnv, maxBuffer = 65536): Buffer {
  return specGit(root, args, { env, maxBuffer, discovery: args[0] === "ls-files" }).stdout;
}
function rootInfo(path: string, env: NodeJS.ProcessEnv): { root: string; commonDir: string } {
  try { absolute(path, "spec worktree"); }
  catch { throw new Error("spec source: worktree must be an absolute path without control characters; pass the repository root"); }
  let root: string;
  try { root = realPath(path); } catch { throw new Error("spec source: worktree root is unavailable; restore the repository or select an existing worktree"); }
  // rev-parse has no NUL-output mode: root paths reject control characters, and exactly two lines are required.
  const lines = git(root, ["rev-parse", "--show-toplevel", "--git-common-dir"], env).toString("utf8").replace(/\n$/, "").split("\n");
  if (lines.length !== 2 || lines[0]?.normalize("NFC") !== root.normalize("NFC") || !lines[1]) throw new Error("spec source: selected path is not a git working-tree root; select the root from git rev-parse --show-toplevel");
  let commonDir: string;
  try { commonDir = realPath(resolve(root, lines[1])); } catch { throw new Error("spec source: git common directory is unavailable; repair the repository before retrying"); }
  return { root, commonDir };
}
function directoryIdentity(root: string): string | undefined {
  try {
    const stat = lstatSync(root, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch (error) { throw new Error("spec source: canonical root cannot be inspected; restore the worktree directory and access, then reopen the source index", { cause: error }); }
}
function bind(source: SpecSourceSpec, options: SpecSourceOptions): Binding {
  const env = options.env ?? process.env, registered = rootInfo(source.path, env);
  if (registered.root !== source.path) throw new Error("spec source: registered root is no longer canonical; restore the canonical root or preview unregistering it with vmem specs remove <id>, then confirm removal before adding the new root");
  const selected = options.worktree === undefined ? registered : rootInfo(options.worktree, env);
  if (selected.commonDir !== registered.commonDir) throw new Error("spec source: worktree belongs to another repository; select a worktree sharing the registered repository's git common directory");
  const rootIdentity = directoryIdentity(selected.root);
  if (rootIdentity === undefined) throw new Error("spec source: selected root is not a plain directory; restore the canonical worktree root and retry");
  return { root: selected.root, registeredRoot: registered.root, commonDir: selected.commonDir, rootIdentity, env };
}
export function resolveSpecWorktree(source: SpecSourceSpec, worktree?: string, env: NodeJS.ProcessEnv = process.env): string {
  return bind(source, { worktree, env }).root;
}
function validate(binding: Binding): void {
  const registered = rootInfo(binding.registeredRoot, binding.env), selected = rootInfo(binding.root, binding.env);
  if (registered.root !== binding.registeredRoot || selected.root !== binding.root || registered.commonDir !== binding.commonDir || selected.commonDir !== binding.commonDir || directoryIdentity(binding.root) !== binding.rootIdentity) throw new Error("spec source: repository/worktree binding changed; resolve the registered source again before retrying");
}
/** A canonical root plus component checks permits filesystem spelling aliases without following links. */
function pathProblem(binding: Binding, path: string): string | undefined {
  const root = binding.root;
  const parts = path.split("/"), contained = relative(root, resolve(root, path));
  if (!path.endsWith(".md") || isAbsolute(path) || parts.some(part => !part || part === "." || part === "..") || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw new Error(`spec source ${path}: git returned an unsafe Markdown path; repair the index and retry discovery`);
  let rootIdentity: string | undefined;
  try { rootIdentity = directoryIdentity(root); }
  catch (error) { throw new Error(`spec source ${path}: canonical root cannot be inspected; restore root access and retry`, { cause: error }); }
  if (rootIdentity !== binding.rootIdentity) return `spec source ${path}: root directory identity changed; restore the original root before retrying`;
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return `spec source ${path}: path is missing; restore the tracked file or stage its deletion before retrying`;
      throw new Error(`spec source ${path}: Markdown path cannot be inspected; restore read access and retry discovery`, { cause: error });
    }
    if (stat.isSymbolicLink()) return `spec source ${path}: symlink component excluded; replace it with a plain file or directory before retrying`;
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return `spec source ${path}: path is not a regular Markdown file with directory parents; restore the plain file and retry`;
  }
  let physical: string;
  try { physical = realPath(current); }
  catch (error) { throw new Error(`spec source ${path}: physical Markdown path cannot be resolved; restore read access and a plain path, then retry`, { cause: error }); }
  // Git's full spelling may differ, but the file must stay below the captured physical root.
  const physicalRelative = relative(root, physical);
  if (physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) return `spec source ${path}: physical path leaves the registered root; restore the original root and plain in-repository file before retrying`;
  return undefined;
}
function namedSpec(path: string): boolean { return basename(path) === "SPEC.md"; }
function candidateData(path: string, data: Record<string, unknown>): boolean { return namedSpec(path) || Object.hasOwn(data, "id") || Object.hasOwn(data, "type"); }
function candidateProbe(path: string, reason: "oversized" | "invalid_utf8", bytes: Buffer): boolean {
  if (namedSpec(path)) return true;
  try {
    const document = parseFrontmatter(bytes.toString("utf8"));
    if (!document.frontmatter) return false;
    // This is a conservative signal only: visible reserved keys keep the blocking encoding error.
    // Accepted documents are still decoded strictly by the scanner.
    return candidateData(path, document.data);
  } catch (error) {
    if (reason === "oversized" && error instanceof Error && error.message === "frontmatter: missing closing delimiter") throw new Error(`spec source ${path}: frontmatter exceeds the bounded candidate probe; shorten the header before validating`, { cause: error });
    return false;
  }
}
function adapter(binding: Binding) {
  let specs: SpecDocument[] = [], candidates: SpecCandidate[] = [], diagnostics: SpecDiagnostic[] = [];
  const seen = new Map<string, string>();
  const source: IndexSourceAdapter = {
    validate: () => validate(binding),
    paths: () => {
      specs = []; candidates = []; diagnostics = []; seen.clear();
      const bytes = git(binding.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], binding.env, 8 * 1024 * 1024);
      let output: string;
      try { output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error("spec source: Git paths are not valid UTF-8; repair the filenames before retrying discovery"); }
      if (output && !output.endsWith("\0")) throw new Error("spec source: git returned incomplete NUL-delimited paths; retry discovery on a stable repository");
      const paths = [...new Set(output.split("\0").filter(Boolean))].sort(pathOrder);
      if (paths.length > 10000) throw new Error("spec source: more than 10000 Markdown paths; ignore large or vendored Markdown via .gitignore and untrack already-tracked excluded files with git rm --cached before rebuilding");
      return paths.filter(path => {
        const problem = pathProblem(binding, path);
        if (problem === undefined) return true;
        diagnostics.push({ code: "skipped_path", path, message: problem });
        return false;
      });
    },
    validatePath: path => {
      const problem = pathProblem(binding, path);
      if (problem !== undefined) throw new Error(problem);
    },
    invalid: path => {
      if (!namedSpec(path)) return false;
      diagnostics.push({ code: "invalid_frontmatter", path, message: "spec source: invalid frontmatter; repair the SPEC.md YAML before validating" });
      return true;
    },
    skipFile: (path, reason, bytes) => {
      if (candidateProbe(path, reason, bytes)) return false;
      diagnostics.push({ code: "skipped_path", path, message: `non-candidate Markdown ${path}: ${reason === "oversized" ? "file exceeds the bounded read size" : "file is not valid UTF-8"}; split/re-encode it or exclude it via .gitignore` });
      return true;
    },
    accept: (path, document, hash) => {
      const data = document.data;
      if (candidateData(path, data)) candidates.push({ path, hash, source: document.source, frontmatter: data, body: document.body });
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
  return { source, snapshot: (): SpecSnapshot => ({ root: binding.root, commonDir: binding.commonDir, specs: [...specs], candidates: [...candidates], diagnostics: [...diagnostics] }) };
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
    } catch (error) {
      if (error instanceof IndexCacheError) {
        if (error.message.startsWith("spec index:")) throw error;
        const message = error.message.replace(/^(?:index|analysis): /, "");
        throw new Error(`spec index: ${message}; choose a readable plain cache directory outside protected sources and retry`, { cause: error });
      }
      throw error;
    }
  }
  get file(): string { return this.index.file; }
  close(): void { this.index.close(); }
  scan(rebuild = false): ReturnType<VaultIndex["scan"]> {
    try {
      const result = this.index.scan(rebuild);
      this.current = this.adapter.snapshot();
      return result;
    } catch (error) { this.current = undefined; throw error; }
  }
  snapshot(): SpecSnapshot { if (!this.current) this.scan(); return this.current!; }
  search(query: string, options: SearchOptions & { offset?: number } = {}): SpecSearchResult[] {
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > 10000)) throw new Error("spec search offset: expected integer 0..10000; choose a bounded continuation offset");
    const snapshot = this.snapshot(), ids = new Map(snapshot.specs.map(spec => [spec.path, spec.id]));
    const hashes = new Map(snapshot.specs.map(spec => [spec.path, spec.hash]));
    return this.index.search(query, options, hashes, options.offset ?? 0).flatMap(hit => {
      const id = ids.get(hit.path);
      return id === undefined ? [] : [{ ...hit, id }];
    });
  }
}
/** One-shot discovery is in memory and never opens or creates a cache on disk. */
export function discoverSpecs(source: SpecSourceSpec, options: SpecSourceOptions = {}): SpecSnapshot {
  const index = new SpecIndex(tmpdir(), source, { ...options, memory: true, reuseCache: false, protectedRoots: [] });
  try { index.scan(); return index.snapshot(); } finally { index.close(); }
}
