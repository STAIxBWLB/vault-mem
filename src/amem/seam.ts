/**
 * The only module that imports the `@staix/agent-mem` root. It is loaded lazily by promotion, so
 * `vmem mcp`, reads and writes never pay for it. No agent memory is indexed or copied here: the seam
 * lists candidates from amem's own selection and records amem's own vault link.
 */
import type { MemoryStore, View } from "@staix/agent-mem";

export interface AmemCandidate { id: string; project: string; kind: string; title: string | null; text: string; about: string[]; at: string }
export interface AmemSeam {
  readonly project: string;
  candidates(limit: number): Promise<AmemCandidate[]>;
  /** The durable entry when it is still selectable by policy, linked or not. */
  entry(id: string): Promise<AmemCandidate | undefined>;
  linkedPath(id: string): string | undefined;
  recordLink(id: string, path: string): Promise<string>;
  close(): void;
}
export interface AmemOptions { env?: NodeJS.ProcessEnv; project?: string; cwd?: string; piiPatterns?: string[] }
const ID = /^[a-f0-9]{32}$/;
function view(value: View): AmemCandidate {
  return { id: value.id, project: value.project, kind: value.kind, title: value.title, text: value.text, about: value.about.map(node => String(node)), at: value.at };
}
/** Open the curated store of one project. Listing and linking both require the generation profile. */
export async function openAmem(options: AmemOptions = {}): Promise<AmemSeam> {
  const amem = await import("@staix/agent-mem");
  const env = options.env ?? process.env, base = amem.memoryHome(env);
  const project = options.project ?? amem.memoryProjectKey(options.cwd ?? process.cwd());
  if (!project.trim() || project.length > 400) throw new Error("amem: invalid project key");
  const policy = amem.createStandalonePolicy({ ...(options.piiPatterns?.length ? { piiPatterns: [...options.piiPatterns] } : {}) });
  const { existsSync } = await import("node:fs"), { join } = await import("node:path");
  const store: MemoryStore = existsSync(join(base, "shards.json"))
    ? amem.openShardStore({ memoryDir: base, project, deferPromotions: true })
    : new amem.MemoryStore({ memoryDir: base, deferPromotions: true });
  if (store.profile.kind !== "generation") { store.close(); throw new Error("amem: promotion requires a generation memory profile; run amem's migration first"); }
  const selection = (limit?: number) => ({ project, policy, ...(limit !== undefined ? { limit } : {}) });
  return {
    project,
    async candidates(limit) { return (await amem.vaultCandidates(store, selection(limit))).map(view); },
    async entry(id) {
      if (!ID.test(id)) return undefined;
      const found = store.vaultEntries(project).find(row => row.view.id === id);
      // The same policy screen as candidate listing runs before any entry text reaches a preview.
      return found && await policy.screen(found.view) ? view(found.view) : undefined;
    },
    linkedPath(id) { return store.vaultLinks(project).find(row => row.target === id)?.path; },
    recordLink(id, path) { return amem.recordVaultLink(store, id, path, selection()); },
    close() { store.close(); },
  };
}
/** Cross-project candidate table from amem's own selection, read-only. */
export async function allProjectCandidates(options: { env?: NodeJS.ProcessEnv; limit?: number; piiPatterns?: string[] }): Promise<{ project: string; candidates: AmemCandidate[] }[]> {
  const amem = await import("@staix/agent-mem");
  const policy = amem.createStandalonePolicy({ ...(options.piiPatterns?.length ? { piiPatterns: [...options.piiPatterns] } : {}) });
  const result = await amem.vaultCandidatesAll(amem.memoryHome(options.env ?? process.env), { policy, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  return result.projects.map(entry => ({ project: entry.project, candidates: entry.candidates.map(view) }));
}
