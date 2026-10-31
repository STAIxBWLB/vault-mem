import { MAX_REPORT_BYTES } from "./write-validation.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { sourceWorkspaceRoot, missingSourceWarnings, sourceReferences } from "./source.ts";
import { parseAnalysisYaml } from "./analysis-yaml.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { VaultSpec, VmemConfig } from "./config.ts";
import type { AnalysisSnapshot } from "./analysis-types.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { loadRegistry } from "./registry.ts";
import { VaultIndex } from "./vault-index.ts";
/** Read bounded auxiliary inputs without following links. Never read note files here. */
export function analysisRead(file: string, maximum = 2 * 1024 * 1024): string | null {
  let fd: number;
  try {
    if (realpathSync(dirname(file)) !== dirname(file)) throw new Error("analysis: linked input directory");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw new Error("analysis: auxiliary input exceeds bound or is not plain");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length-size, null); size += n; if (!n) break; }
    const after = fstatSync(fd);
    if (size !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("analysis: input changed during read");
    return bytes.subarray(0,size).toString("utf8");
  } finally { closeSync(fd); }
}
function permitted(file: string, config: VmemConfig): void {
  if (isDenied(canonicalPath(file), config.denyPaths ?? [])) throw new Error("analysis: input path is denied");
}
export function analysisInput(home: string, id: string, options: { today?: string; memory?: boolean; expectedVault?: VaultSpec } = {}): { snapshot: AnalysisSnapshot; vault: VaultSpec; config: VmemConfig; identity: {dev:number;ino:number} } {
  const config = loadRegistry(home), vault = config.vaults.find(v => v.id === id);
  if (!vault) throw new Error("analysis: unknown vault id");
  if (options.expectedVault && JSON.stringify(options.expectedVault) !== JSON.stringify(vault)) throw new Error("analysis: startup vault binding changed; restart MCP");
  const identity = lstatSync(vault.path);
  const today = options.today ?? new Date().toISOString().slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(Date.parse(today)) || new Date(today).toISOString().slice(0,10) !== today) throw new Error("analysis: invalid date");
  permitted(vault.path, config);
  // Check denied paths before opening the index or reading note sources.
  for (const entry of readdirSync(join(vault.path,"notes"), { withFileTypes:true })) if (entry.isFile() && entry.name.endsWith(".md")) permitted(join(vault.path,"notes",entry.name), config);
  const logPath = join(vault.path,"log"), reportsDir = join(vault.path,"reports"), reports: Record<string,string> = {};
  permitted(logPath,config); permitted(reportsDir,config);
  let entries: string[] = [];
  try {
    if (lstatSync(reportsDir).isSymbolicLink() || realpathSync(reportsDir) !== reportsDir) throw new Error("analysis: reports directory must be plain");
    entries = readdirSync(reportsDir).filter(s => s === "vault-graph.json" || s === "graph-trend.md" || /^graph-report-.*\.md$/.test(s)).sort();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (entries.length > 1000) throw new Error("analysis: report count exceeds bound");
  let bytes = 0;
  for (const name of entries) {
    const file = join(reportsDir,name); permitted(file,config);
    const source = analysisRead(file, MAX_REPORT_BYTES); if (source !== null) { bytes += Buffer.byteLength(source); if (bytes > MAX_REPORT_BYTES) throw new Error("analysis: reports exceed aggregate bound"); reports[name] = source; }
  }
  let registryIds: string[] | null = null;
  if (vault.registry) {
    permitted(vault.registry,config);
    const source = analysisRead(vault.registry);
    if (source !== null) {
      const registry = parseAnalysisYaml(source) as { projects?: { id?: unknown }[] } | null;
      if (registry?.projects !== undefined && !Array.isArray(registry.projects)) throw new Error("analysis: registry projects must be array");
      registryIds = (registry?.projects ?? []).filter(v => v && typeof v === "object").map(v => v.id).filter((v): v is string => typeof v === "string");
    }
  }
  const inputs = { today, logPath, log: analysisRead(logPath, 32 * 1024 * 1024), registryIds, reports };
  const index = new VaultIndex(home,vault,config.vaults.map(v => v.path),{ memory: options.memory ?? true });
  try {
    index.scan(false,{captureInvalidFrontmatter:true});
    const after = lstatSync(vault.path);
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.isSymbolicLink()) throw new Error("analysis: vault changed during snapshot");
    const snapshot=index.analysisSnapshot(inputs),sourceRoot=sourceWorkspaceRoot(vault),warnings:Record<string,string[]>={};
    if(sourceRoot)for(const note of snapshot.notes)try{
      const value=parseFrontmatter(note.source).data.source;
      const denied=value!==undefined&&sourceReferences(value).some(ref=>isDenied(ref.value,config.denyPaths??[])||(ref.kind==="path"&&isDenied(canonicalPath(resolve(sourceRoot,ref.value)),config.denyPaths??[])));
      const found=denied?["source is denied by the path policy"]:missingSourceWarnings(value,sourceRoot);
      if(found.length)warnings[note.path]=found;
    }catch{ /* Invalid frontmatter remains visible to L02; do not infer missing source paths. */ }
    if(Object.keys(warnings).length)snapshot.sourceWarnings=warnings;
    return {vault,config,identity:{dev:Number(identity.dev),ino:Number(identity.ino)},snapshot};
  }
  finally { index.close(); }
}
