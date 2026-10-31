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
export interface MineAmemRecord { source: "curated" | "capture"; kind: string; at: string; text: string; project: string }
export interface MineAmemRead { records: MineAmemRecord[]; projects: string[]; screened: number; truncatedCapture: number; unreadable: number }
const MINE_KINDS = new Set(["decision", "finding", "contract", "fail"]);
const MINE_EVENTS = new Set(["UserPromptSubmit", "observation", "summary"]);
/**
 * Skill mining input, read-only: curated entries (screened by amem's standalone policy plus the vault's piiPatterns) and
 * capture rows (events UserPromptSubmit/observation/summary) of every active project, or one. Opens nothing that does not
 * exist: an absent home, a capture-only shard or an unsplit home without curated logs yields no rows, never a new store.
 */
export async function readAmemForMining(options: { env?: NodeJS.ProcessEnv; project?: string; since: string; piiPatterns?: string[]; maxCaptureRows?: number }): Promise<MineAmemRead> {
  const amem = await import("@staix/agent-mem");
  const { existsSync } = await import("node:fs"), { basename, join } = await import("node:path");
  const base = amem.memoryHome(options.env ?? process.env), maxRows = options.maxCaptureRows ?? 20000;
  const out: MineAmemRead = { records: [], projects: [], screened: 0, truncatedCapture: 0, unreadable: 0 };
  if (!existsSync(base)) return out;
  const policy = amem.createStandalonePolicy({ ...(options.piiPatterns?.length ? { piiPatterns: [...options.piiPatterns] } : {}) });
  const state = amem.lifecycleResolver(base);
  const sharded = existsSync(join(base, "shards.json"));
  const unsplitCurated = !sharded && ["log", "local", "generations"].some(name => existsSync(join(base, name)));
  const shared: MemoryStore | undefined = unsplitCurated ? new amem.MemoryStore({ memoryDir: base, deferPromotions: true }) : undefined;
  try {
    // A split home lists its projects as shards; an unsplit home keeps curated projects in the one shared store.
    const machineDirs = new Map(amem.walkShards(base).map(shard => [shard.key, shard.machineDirs]));
    for (const view of shared?.list({ limit: 1_000_000, includeSuperseded: true }) ?? []) if (!machineDirs.has(view.project)) machineDirs.set(view.project, []);
    const shards = [...machineDirs].map(([key, dirs]) => ({ key, machineDirs: dirs }))
      .filter(shard => state(shard.key) === "active" && (options.project === undefined || shard.key === options.project))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (options.project !== undefined && !shards.length) throw new Error(`amem: no active project shard for ${options.project}`);
    for (const shard of shards) {
      out.projects.push(shard.key);
      const store: MemoryStore | undefined = shared ?? (sharded && existsSync(join(amem.shardDir(base, shard.key), "generation.json"))
        ? amem.openShardStore({ memoryDir: base, project: shard.key, deferPromotions: true, lifecycle: "ignore" }) : undefined);
      try {
        for (const { view } of store?.vaultEntries(shard.key) ?? []) {
          if (!MINE_KINDS.has(view.kind) || view.supersededBy || view.at < options.since) continue;
          if (!await policy.screen(view)) { out.screened++; continue; }
          out.records.push({ source: "curated", kind: view.kind, at: view.at, text: [view.title, view.text].filter(Boolean).join("\n"), project: shard.key });
        }
      } catch { out.unreadable++; }
      finally { if (store && store !== shared) store.close(); }
      for (const dir of shard.machineDirs) {
        let capture: InstanceType<typeof amem.CaptureStore> | undefined;
        try {
          capture = new amem.CaptureStore({ memoryDir: base, project: shard.key, machine: basename(dir), readOnly: true, recentReadRows: true, maxReadRows: maxRows });
          if (capture.recentReadTruncated) out.truncatedCapture++;
          for (const row of capture.rows({ limit: maxRows })) {
            if (!MINE_EVENTS.has(row.event) || row.at < options.since || !row.excerpt.trim()) continue;
            out.records.push({ source: "capture", kind: row.event, at: row.at, text: row.excerpt, project: shard.key });
          }
        } catch { out.unreadable++; }
        finally { capture?.close(); }
      }
    }
  } finally { shared?.close(); }
  return out;
}
/** Cross-project candidate table from amem's own selection, read-only. */
export async function allProjectCandidates(options: { env?: NodeJS.ProcessEnv; limit?: number; piiPatterns?: string[] }): Promise<{ project: string; candidates: AmemCandidate[] }[]> {
  const amem = await import("@staix/agent-mem");
  const policy = amem.createStandalonePolicy({ ...(options.piiPatterns?.length ? { piiPatterns: [...options.piiPatterns] } : {}) });
  const result = await amem.vaultCandidatesAll(amem.memoryHome(options.env ?? process.env), { policy, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  return result.projects.map(entry => ({ project: entry.project, candidates: entry.candidates.map(view) }));
}
