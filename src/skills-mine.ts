import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analysisInput, analysisRead } from "./analysis-input.ts";
import type { VmemConfig } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { canonicalPath, isDenied } from "./platform.ts";
import { codePointCompare as compare, labelCommunities } from "./vault-graph.ts";
import { SECRET_PATTERNS } from "./write-validation.ts";

/**
 * `vmem skills mine`: read-only skill-candidate mining over amem memory and vault notes, a port of the skill-mine
 * Python pipeline (materialize.py dictionary matching and masking, analyze.py scoring). Nothing is written: no vault
 * file, lock, cache, log event, vmem home file or amem content. The caller decides where the report goes.
 */
export const MAX_RECORDS = 20000;
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_FILES = 2000;
const MAX_VOCAB_BYTES = 1024 * 1024;
const EXCLUDED_NOTE_TYPES = new Set(["person", "moc", "reference"]);
const SAMPLE_CHARS = 160;

export type RecordSource = "curated" | "capture" | "vault";
export interface MineRecord { source: RecordSource; kind: string; at: string; text: string; project: string }
export interface VocabEntry { canon: string; surface: string[] }
export interface RegistryProject { id?: unknown; name?: unknown; keywords?: { ko?: unknown; en?: unknown }; acronyms?: unknown; people?: unknown; orgs?: unknown; sub_projects?: unknown }
export type SurfaceKind = "action" | "object" | "project" | "person" | "org";
export interface Surface { surface: string; kind: SurfaceKind; canon: string }
export interface SkillEntry { name: string; bag: Set<string> }
export interface SimilarSkill { name: string; similarity: number }
export interface Candidate {
  cid: number; label: string; gloss: string; size: number; day_span: number; unique_days: number;
  cohesion: number; novelty: number; rank: number; triggers: string[]; trigger_nodes: string[];
  similar_skills: SimilarSkill[]; sources: Record<RecordSource, number>;
  samples: { source: RecordSource; kind: string; at: string; text: string }[];
  reason?: string;
}
export interface MineOptions {
  vault: string; days?: number; project?: string; allProjects?: boolean; vocab?: string; skills?: string[];
  minSize?: number; minNovelty?: number; env?: NodeJS.ProcessEnv; now?: Date;
}
export interface MineResult {
  vault: string; days: number; since: string; projects: string[];
  records: Record<RecordSource, number>;
  dropped: { secret: number; policy: number; oversized: number; duplicate: number; unreadable: number; truncatedCapture: number };
  graph: { nodes: number; edges: number; communities: number; partitioner: "label-propagation" };
  godNodes: { id: string; degree: number }[];
  candidates: Candidate[];
  rejected: { below3: number; detailed: Candidate[] };
  surprising: { source: string; target: string; source_community: number; target_community: number; score: number }[];
  report: string;
}

// ── materialize.py ────────────────────────────────────────────────────

/** slugify(): lowercase, spaces to hyphens, everything outside [0-9A-Za-z가-힣._-] to one hyphen. */
export function slugify(name: string): string {
  let s = name.trim().toLowerCase().replaceAll(" ", "-");
  s = s.replace(/[^0-9A-Za-z가-힣._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unnamed";
}
const isAscii = (text: string) => /^[\x00-\x7f]*$/.test(text);
const strings = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const pyStr = (value: unknown): string => value === null || value === undefined ? "" : typeof value === "boolean" ? (value ? "True" : "False") : String(value);
/** build_surface_index(): (surface, kind, canon) deduplicated and sorted longest-first, then by surface. */
export function buildSurfaceIndex(actions: VocabEntry[], objects: VocabEntry[], projects: RegistryProject[]): Surface[] {
  const entries: [unknown, SurfaceKind, string][] = [];
  for (const a of actions) if (a.canon) for (const s of a.surface ?? []) entries.push([s, "action", a.canon]);
  for (const o of objects) if (o.canon) for (const s of o.surface ?? []) entries.push([s, "object", o.canon]);
  for (const p of projects) {
    const pid = typeof p.id === "string" && p.id ? p.id : undefined;
    if (!pid) continue;
    const kw = p.keywords && typeof p.keywords === "object" ? p.keywords : {};
    for (const s of [...strings(kw.ko), ...strings(kw.en)]) entries.push([s, "project", pid]);
    for (const s of strings(p.acronyms)) entries.push([s, "project", pid]);
    for (const s of strings(p.people)) entries.push([s, "person", personId(pyStr(s))]);
    for (const s of strings(p.orgs)) entries.push([s, "org", slugify(pyStr(s))]);
    for (const sp of strings(p.sub_projects)) {
      if (!sp || typeof sp !== "object") continue;
      const spid = typeof (sp as { id?: unknown }).id === "string" && (sp as { id: string }).id ? (sp as { id: string }).id : pid;
      for (const s of strings((sp as { keywords_extra?: unknown }).keywords_extra)) entries.push([s, "project", spid]);
    }
  }
  const seen = new Set<string>(), unique: Surface[] = [];
  for (const [raw, kind, canon] of entries) {
    const surface = pyStr(raw);
    if (!surface.trim()) continue;
    const key = JSON.stringify([surface, kind, canon]);
    if (seen.has(key)) continue;
    seen.add(key); unique.push({ surface, kind, canon });
  }
  return unique.sort((a, b) => Array.from(b.surface).length - Array.from(a.surface).length || compare(a.surface, b.surface));
}
/** find_matches(): every surface contained in the text; ASCII surfaces case-insensitively, others exactly. */
export function findMatches(text: string, index: readonly Surface[]): Set<string> {
  const hits = new Set<string>(), lowered = text.toLowerCase();
  for (const { surface, kind, canon } of index) {
    if (!surface) continue;
    const ascii = isAscii(surface);
    if ((ascii ? lowered : text).includes(ascii ? surface.toLowerCase() : surface)) hits.add(nodeId(kind, canon));
  }
  return hits;
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PATH = /(?:(?:\/|~\/)[\p{L}\p{N}_.\-/]+|[A-Z]:\\[\p{L}\p{N}_.\-\\]+)/gu;
/** mask_text(): emails, absolute paths, then registry people (longest first). */
export function maskText(text: string, people: readonly string[]): string {
  let masked = text.replace(EMAIL, "[EMAIL]").replace(PATH, "[PATH]");
  for (const name of people) if (name && masked.includes(name)) masked = masked.replaceAll(name, "[PERSON]");
  return masked;
}
export function allPeople(projects: RegistryProject[]): string[] {
  const names = new Set<string>();
  for (const p of projects) for (const n of strings(p.people)) if (pyStr(n)) names.add(pyStr(n));
  return [...names].sort((a, b) => Array.from(b).length - Array.from(a).length || compare(a, b));
}
/** A person node never carries the name: its id is a short digest of the slug. */
function personId(name: string): string { return "p" + createHash("sha256").update(slugify(name)).digest("hex").slice(0, 10); }
/** Node ids: `action--<canon>`, `object--<canon>`, `entity--<kind>--<slug>`. */
export function nodeId(kind: SurfaceKind, canon: string): string {
  return kind === "action" || kind === "object" ? `${kind}--${slugify(canon)}` : `entity--${kind}--${kind === "person" ? canon : slugify(canon)}`;
}
const kindOf = (id: string) => id.split("--", 1)[0]!;
/** analyze.py's trigger label: everything after the first `--` (`org--acme-corp` for an entity; a person stays a digest). */
export function nodeLabel(id: string): string {
  const at = id.indexOf("--");
  return at < 0 ? id : id.slice(at + 2);
}

// ── analyze.py ────────────────────────────────────────────────────────

/** _parse_frontmatter(): the line parser analyze.py uses for SKILL.md (continuation lines append). */
export function skillFrontmatter(text: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  let key: string | undefined;
  for (const line of match[1]!.split("\n")) {
    if (line.includes(":") && !line.startsWith(" ")) {
      const colon = line.indexOf(":");
      key = line.slice(0, colon).trim(); out[key] = line.slice(colon + 1).trim();
    } else if (key) out[key] = ((out[key] ?? "") + " " + line.trim()).trim();
  }
  return out;
}
export function tokenize(text: string): Set<string> {
  return new Set((text.match(/[가-힣A-Za-z0-9_-]{2,}/g) ?? []).map(token => token.toLowerCase()));
}
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const DAY = 86400000;
function timestamp(value: string): number | undefined {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}
export interface ScoreGraph { neighbors: Map<string, Set<string>>; records: Map<string, MineRecord> }
/** community_to_candidate(): null below three records, else the scored candidate. */
export function communityToCandidate(cid: number, members: readonly string[], graph: ScoreGraph, existing: readonly SkillEntry[], people: readonly string[] = []): Candidate | null {
  const records = members.filter(id => graph.records.has(id));
  if (records.length < 3) return null;
  const times = records.map(id => timestamp(graph.records.get(id)!.at)).filter((t): t is number => t !== undefined).sort((a, b) => a - b);
  let daySpan = 1, uniqueDays = 1;
  if (times.length >= 2) {
    daySpan = Math.max(1, Math.floor((times.at(-1)! - times[0]!) / DAY));
    uniqueDays = new Set(times.map(t => new Date(t).toISOString().slice(0, 10))).size;
  }
  const membership = new Set(members), counts = new Map<string, number>();
  for (const id of records) for (const neighbor of graph.neighbors.get(id) ?? []) {
    if (!graph.records.has(neighbor) && membership.has(neighbor)) counts.set(neighbor, (counts.get(neighbor) ?? 0) + 1);
  }
  // Counter.most_common: ties keep first-encounter order (records in member order, neighbors in edge order); sort is stable.
  const ranked = [...counts].sort(([, ac], [, bc]) => bc - ac).slice(0, 20).map(([id]) => id);
  const triggers: string[] = [], seenLabels = new Set<string>();
  for (const id of ranked) {
    const label = nodeLabel(id);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label); triggers.push(id);
    if (triggers.length >= 8) break;
  }
  const actions = triggers.filter(id => kindOf(id) === "action"), objects = triggers.filter(id => kindOf(id) === "object");
  let parts = [...(actions.length ? [nodeLabel(actions[0]!)] : []), ...(objects.length ? [nodeLabel(objects[0]!)] : [])];
  if (!parts.length) parts = triggers.slice(0, 2).map(nodeLabel);
  const label = parts.join("-") || `cluster-${cid}`;
  const gloss = triggers.slice(0, 3).map(nodeLabel).join(" + ");
  let internal = 0;
  for (const id of members) for (const neighbor of graph.neighbors.get(id) ?? []) if (membership.has(neighbor) && compare(id, neighbor) < 0) internal++;
  const n = members.length, possible = n > 1 ? n * (n - 1) / 2 : 1;
  const cohesion = possible ? internal / possible : 0;
  const bag = new Set([...triggers.map(id => nodeLabel(id).toLowerCase()), label.toLowerCase()]);
  // Stable descending sort, as Python's list.sort: ties keep catalog order.
  const overlaps = existing.map(skill => ({ name: skill.name, similarity: jaccard(bag, skill.bag) })).sort((a, b) => b.similarity - a.similarity);
  const novelty = 1 - (overlaps[0]?.similarity ?? 0);
  const rank = Math.log2(Math.max(2, records.length)) * (uniqueDays / daySpan) * Math.max(0.1, cohesion) * Math.max(0.1, novelty);
  const sources: Record<RecordSource, number> = { curated: 0, capture: 0, vault: 0 };
  for (const id of records) sources[graph.records.get(id)!.source]++;
  const samples = records.slice(0, 5).map(id => {
    const record = graph.records.get(id)!, text = maskText(record.text, people).replace(/\s+/g, " ").trim();
    return { source: record.source, kind: record.kind, at: record.at, text: Array.from(text).length > SAMPLE_CHARS ? Array.from(text).slice(0, SAMPLE_CHARS).join("") + "…" : text };
  });
  return {
    cid, label, gloss, size: records.length, day_span: daySpan, unique_days: uniqueDays, cohesion: round3(cohesion), novelty: round3(novelty), rank: round3(rank),
    triggers: triggers.map(nodeLabel), trigger_nodes: triggers, similar_skills: overlaps.slice(0, 3).filter(o => o.similarity > 0).map(o => ({ name: o.name, similarity: round3(o.similarity) })),
    sources, samples,
  };
}

// ── inputs ────────────────────────────────────────────────────────────

function plainFile(file: string, config: VmemConfig, maximum: number): string | null {
  if (isDenied(canonicalPath(file), config.denyPaths ?? [])) throw new Error(`skills mine: input path is denied: ${file}`);
  return analysisRead(file, maximum);
}
function parseYaml(source: string, what: string): unknown {
  try { return Bun.YAML.parse(source); } catch { throw new Error(`skills mine: invalid YAML in ${what}`); }
}
export function loadVocab(dir: string | undefined, config: VmemConfig): { actions: VocabEntry[]; objects: VocabEntry[] } {
  if (!dir) return { actions: [], objects: [] };
  const read = (name: "actions" | "objects"): VocabEntry[] => {
    const source = plainFile(join(canonicalPath(dir), `${name}.yaml`), config, MAX_VOCAB_BYTES);
    if (source === null) throw new Error(`skills mine: --vocab has no ${name}.yaml`);
    const value = parseYaml(source, `${name}.yaml`) as Record<string, unknown> | null;
    return strings(value?.[name]).filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter(e => typeof e.canon === "string" && e.canon).map(e => ({ canon: e.canon as string, surface: strings(e.surface).map(pyStr) }));
  };
  return { actions: read("actions"), objects: read("objects") };
}
export function loadRegistryProjects(file: string | undefined, config: VmemConfig): RegistryProject[] {
  if (!file) return [];
  const source = plainFile(file, config, MAX_VOCAB_BYTES);
  if (source === null) return [];
  const value = parseYaml(source, "the project registry") as { projects?: unknown } | null;
  return strings(value?.projects).filter((p): p is RegistryProject => !!p && typeof p === "object");
}
/** scan_existing_skills(): SKILL.md under each directory (sorted walk), first name wins, bag of name + description. */
export function scanSkills(dirs: readonly string[], config: VmemConfig): SkillEntry[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || isDenied(dir, config.denyPaths ?? [])) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(path);
        if (files.length > MAX_SKILL_FILES) throw new Error(`skills mine: skill catalog exceeds ${MAX_SKILL_FILES} files`);
      }
    }
  };
  for (const dir of dirs) {
    const root = canonicalPath(dir);
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`skills mine: --skills is not a directory: ${dir}`);
    walk(root, 0);
  }
  const catalog: SkillEntry[] = [], seen = new Set<string>();
  for (const file of files) {
    let fm: Record<string, string>;
    try { fm = skillFrontmatter(plainFile(file, config, 256 * 1024) ?? ""); } catch { continue; }
    const name = fm.name || file.split("/").at(-2)!;
    if (seen.has(name)) continue;
    seen.add(name);
    catalog.push({ name, bag: tokenize(`${fm.name ?? ""} ${fm.description ?? ""}`) });
  }
  return catalog;
}
/** Vault notes as records: every type but person/moc/reference; `at` from created/date, else the file mtime. */
export function vaultRecords(home: string, vault: string, since: string): { records: MineRecord[]; config: VmemConfig; registry: string | undefined; unreadable: number } {
  const { snapshot, vault: spec, config } = analysisInput(home, vault, { memory: true });
  const records: MineRecord[] = [];
  let unreadable = 0;
  for (const note of snapshot.notes) {
    let data: Record<string, unknown>, body: string;
    try { const parsed = parseFrontmatter(note.source); data = parsed.data; body = parsed.body; } catch { unreadable++; continue; }
    const type = typeof data.type === "string" ? data.type : "";
    if (EXCLUDED_NOTE_TYPES.has(type)) continue;
    const declared = [data.created, data.date].find(v => typeof v === "string" && timestamp(v) !== undefined) as string | undefined;
    let at = declared;
    if (at === undefined) {
      const stat = lstatSync(join(spec.path, "notes", note.path.replace(/^notes\//, "")), { throwIfNoEntry: false });
      if (!stat) { unreadable++; continue; }
      at = stat.mtime.toISOString();
    }
    if (new Date(timestamp(at)!).toISOString() < since) continue;
    const title = typeof data.title === "string" ? data.title : note.path.replace(/^notes\//, "").replace(/\.md$/, "");
    const description = typeof data.description === "string" ? data.description : "";
    records.push({ source: "vault", kind: type || "note", at, text: [title, description, body.trim()].filter(Boolean).join("\n"), project: `vault:${vault}` });
  }
  return { records, config, registry: spec.registry, unreadable };
}

// ── pipeline ──────────────────────────────────────────────────────────

export interface MineInputs {
  vault: string; days: number; since: string; projects: string[]; records: MineRecord[];
  vocab: { actions: VocabEntry[]; objects: VocabEntry[] }; registry: RegistryProject[]; skills: SkillEntry[];
  minSize: number; minNovelty: number; today: string;
  dropped?: Partial<MineResult["dropped"]>;
}
/** The pure part: screen, mask, match, cluster, score and render. */
export function mineRecords(input: MineInputs): MineResult {
  const dropped: MineResult["dropped"] = { secret: 0, policy: 0, oversized: 0, duplicate: 0, unreadable: 0, truncatedCapture: 0, ...input.dropped };
  const ordered = [...input.records].sort((a, b) => compare(a.at, b.at) || compare(a.source, b.source) || compare(a.project, b.project) || compare(a.text, b.text));
  const kept: MineRecord[] = [], texts = new Set<string>();
  let total = 0;
  for (const record of ordered) {
    const text = record.text.trim();
    if (SECRET_PATTERNS.some(pattern => pattern.test(text))) { dropped.secret++; continue; }
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_RECORD_BYTES) { dropped.oversized++; continue; }
    if (texts.has(text)) { dropped.duplicate++; continue; }
    texts.add(text); kept.push({ ...record, text });
    total += bytes;
    if (kept.length > MAX_RECORDS) throw new Error(`skills mine: more than ${MAX_RECORDS} records; narrow --days or --project`);
    if (total > MAX_TOTAL_BYTES) throw new Error("skills mine: records exceed 64 MiB; narrow --days or --project");
  }
  const index = buildSurfaceIndex(input.vocab.actions, input.vocab.objects, input.registry), people = allPeople(input.registry);
  const recordIds = new Map<string, MineRecord>(), neighbors = new Map<string, Set<string>>(), edges: [string, string][] = [];
  const width = String(kept.length).length;
  kept.forEach((record, i) => {
    const id = `record--${String(i + 1).padStart(width, "0")}`;
    recordIds.set(id, record); neighbors.set(id, new Set());
    for (const hit of [...findMatches(record.text, index)].sort(compare)) {
      if (!neighbors.has(hit)) neighbors.set(hit, new Set());
      neighbors.get(id)!.add(hit); neighbors.get(hit)!.add(id); edges.push([id, hit]);
    }
  });
  const ids = [...neighbors.keys()], community = labelCommunities(ids, edges);
  const groups = new Map<number, string[]>();
  for (const id of ids.sort(compare)) { const c = community.get(id)!; groups.set(c, [...(groups.get(c) ?? []), id]); }
  const graph: ScoreGraph = { neighbors, records: recordIds };
  const candidates: Candidate[] = [], detailed: Candidate[] = [];
  let below3 = 0;
  for (const [cid, members] of [...groups].sort(([a], [b]) => a - b)) {
    const candidate = communityToCandidate(cid, members, graph, input.skills, people);
    if (!candidate) { below3++; continue; }
    if (candidate.size < input.minSize) detailed.push({ ...candidate, reason: "size<min" });
    else if (candidate.novelty < input.minNovelty) detailed.push({ ...candidate, reason: "novelty<min" });
    else candidates.push(candidate);
  }
  candidates.sort((a, b) => b.rank - a.rank || a.cid - b.cid);
  const degree = (id: string) => neighbors.get(id)!.size;
  const godNodes = ids.filter(id => !recordIds.has(id)).map(id => ({ id, degree: degree(id) }))
    .sort((a, b) => b.degree - a.degree || compare(a.id, b.id)).slice(0, 10);
  // Vocabulary nodes never link each other directly; cross-community pairs that share a record are the vocab analogue.
  const pairs = new Map<string, MineResult["surprising"][number]>();
  for (const id of recordIds.keys()) {
    const vocab = [...neighbors.get(id)!].sort(compare);
    for (let i = 0; i < vocab.length; i++) for (let j = i + 1; j < vocab.length; j++) {
      const [s, t] = [vocab[i]!, vocab[j]!], cs = community.get(s)!, ct = community.get(t)!;
      if (cs !== ct) pairs.set(`${s}\n${t}`, { source: s, target: t, source_community: cs, target_community: ct, score: degree(s) + degree(t) });
    }
  }
  const used = new Map<string, number>(), surprising: MineResult["surprising"] = [];
  for (const pair of [...pairs.values()].sort((a, b) => b.score - a.score || compare(a.source, b.source) || compare(a.target, b.target))) {
    if ((used.get(pair.source) ?? 0) >= 2 || (used.get(pair.target) ?? 0) >= 2) continue;
    surprising.push(pair); used.set(pair.source, (used.get(pair.source) ?? 0) + 1); used.set(pair.target, (used.get(pair.target) ?? 0) + 1);
    if (surprising.length === 10) break;
  }
  const counts: Record<RecordSource, number> = { curated: 0, capture: 0, vault: 0 };
  for (const record of kept) counts[record.source]++;
  const result: MineResult = {
    vault: input.vault, days: input.days, since: input.since, projects: input.projects, records: counts, dropped,
    graph: { nodes: ids.length, edges: edges.length, communities: groups.size, partitioner: "label-propagation" },
    godNodes, candidates, rejected: { below3, detailed }, surprising, report: "",
  };
  result.report = renderReport(result, input.today, input.minSize, input.minNovelty);
  return result;
}
/** render_report(), with per-candidate source counts and an aggregate line for clusters below three records. */
export function renderReport(result: Omit<MineResult, "report">, today: string, minSize: number, minNovelty: number): string {
  const total = result.records.curated + result.records.capture + result.records.vault;
  const lines = [
    `# Skill Candidates (${today}, memory-based)`, "",
    `- corpus: ${total} records / ${result.days} days (curated ${result.records.curated}, capture ${result.records.capture}, vault ${result.records.vault})`,
    `- projects: ${result.projects.length}`,
    `- dropped: secret ${result.dropped.secret}, policy ${result.dropped.policy}, oversized ${result.dropped.oversized}, duplicate ${result.dropped.duplicate}, unreadable ${result.dropped.unreadable}`,
    `- graph: ${result.graph.nodes} nodes, ${result.graph.edges} edges, ${result.graph.communities} communities (deterministic label propagation)`, "",
  ];
  if (result.godNodes.length) {
    lines.push("## God nodes (workspace vocabulary)", "");
    for (const g of result.godNodes) lines.push(`- \`${g.id}\` (degree ${g.degree})`);
    lines.push("");
  }
  lines.push("## Candidates", "");
  if (!result.candidates.length) lines.push(`_No community met the threshold (size ≥ ${minSize} records, novelty ≥ ${minNovelty})._`, "");
  result.candidates.forEach((c, i) => {
    lines.push(`### ${i + 1}. \`${c.label}\`  (rank ${c.rank})`, "",
      `- size: ${c.size} records / ${c.unique_days} unique days / span ${c.day_span}d`,
      `- sources: curated ${c.sources.curated}, capture ${c.sources.capture}, vault ${c.sources.vault}`,
      `- cohesion: ${c.cohesion}  novelty: ${c.novelty}`, `- gloss: ${c.gloss}`, `- triggers: ${c.triggers.join(", ")}`);
    if (c.similar_skills.length) lines.push(`- overlap with existing skills: ${c.similar_skills.map(s => `\`${s.name}\`(${s.similarity})`).join(", ")}`);
    if (c.samples.length) { lines.push("- samples:"); for (const s of c.samples) lines.push(`  - [${s.source}/${s.kind} ${s.at.slice(0, 10)}] ${s.text}`); }
    lines.push("");
  });
  if (result.surprising.length) {
    lines.push("## Surprising connections (cross-community vocab)", "");
    for (const s of result.surprising) lines.push(`- \`${s.source}\` ↔ \`${s.target}\` (comm ${s.source_community}→${s.target_community}, score ${s.score})`);
    lines.push("");
  }
  if (result.rejected.detailed.length || result.rejected.below3) {
    lines.push("## Rejected", "");
    if (result.rejected.below3) lines.push(`- ${result.rejected.below3} clusters with fewer than 3 records`);
    for (const r of result.rejected.detailed) lines.push(`- ${r.label} (size=${r.size}, novelty=${r.novelty}, reason=${r.reason})`);
    lines.push("");
  }
  lines.push("## Next steps", "",
    "- Review the candidates; add a SKILL.md for a meaningful one through an issue and PR in the skill source repository (never edit the installed runtime copy).",
    "- If dictionary coverage looks thin, extend the skill's `vocab/actions.yaml` and `objects.yaml`.",
    "- When overlap with an existing skill is high, extend that skill's triggers instead of creating a new one.");
  return lines.join("\n") + "\n";
}

/** The whole command: amem through the seam, vault notes through the read-only analysis snapshot, then `mineRecords`. */
export async function mineSkills(home: string, options: MineOptions): Promise<MineResult> {
  const days = options.days ?? 30, minSize = options.minSize ?? 3, minNovelty = options.minNovelty ?? 0.3;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("skills mine: --days takes 1..3650");
  if (!Number.isInteger(minSize) || minSize < 1 || minSize > 10000) throw new Error("skills mine: --min-size takes 1..10000");
  if (!Number.isFinite(minNovelty) || minNovelty < 0 || minNovelty > 1) throw new Error("skills mine: --min-novelty takes 0..1");
  if (options.allProjects && options.project) throw new Error("skills mine: choose either --all-projects or --project");
  const now = options.now ?? new Date(), since = new Date(now.getTime() - days * DAY).toISOString();
  const local = vaultRecords(home, options.vault, since);
  const vocab = loadVocab(options.vocab, local.config), registry = loadRegistryProjects(local.registry, local.config);
  const skills = scanSkills(options.skills ?? [], local.config);
  const { readAmemForMining } = await import("./amem/seam.ts");
  const amem = await readAmemForMining({ env: options.env, since, ...(options.project ? { project: options.project } : {}), piiPatterns: local.config.piiPatterns ?? [] });
  return mineRecords({
    vault: options.vault, days, since, projects: amem.projects, records: [...amem.records, ...local.records], vocab, registry, skills, minSize, minNovelty,
    today: now.toISOString().slice(0, 10), dropped: { policy: amem.screened, unreadable: amem.unreadable + local.unreadable, truncatedCapture: amem.truncatedCapture },
  });
}

const VALUES = ["--days", "--project", "--vocab", "--skills", "--min-size", "--min-novelty"];
const BOOLEANS = ["--all-projects", "--json"];
/** `vmem skills mine <vault> ...`. Prints the JSON result, or the markdown report without --json. */
export async function runSkillsCommand(args: string[], home: string, env: NodeJS.ProcessEnv): Promise<{ text: string; code: number }> {
  if (args[0] !== "mine") throw new Error("skills: use `vmem skills mine <vault>`");
  const flags: Record<string, string | boolean> = {}, skills: string[] = [], positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!VALUES.includes(arg) && !BOOLEANS.includes(arg)) throw new Error(`skills mine: unknown option ${arg}`);
    if (arg !== "--skills" && Object.hasOwn(flags, arg)) throw new Error(`skills mine: repeated option ${arg}`);
    if (BOOLEANS.includes(arg)) { flags[arg] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg}: value required`);
    if (arg === "--skills") skills.push(value); else flags[arg] = value;
  }
  if (positional.length !== 1) throw new Error("skills mine: requires one vault id");
  const number = (flag: string) => {
    const value = flags[flag];
    if (typeof value !== "string") return undefined;
    if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${flag}: expected a number`);
    return Number(value);
  };
  const result = await mineSkills(home, {
    vault: positional[0]!, env, skills, allProjects: flags["--all-projects"] === true,
    ...(typeof flags["--project"] === "string" ? { project: flags["--project"] } : {}),
    ...(typeof flags["--vocab"] === "string" ? { vocab: flags["--vocab"] } : {}),
    ...(number("--days") !== undefined ? { days: number("--days") } : {}),
    ...(number("--min-size") !== undefined ? { minSize: number("--min-size") } : {}),
    ...(number("--min-novelty") !== undefined ? { minNovelty: number("--min-novelty") } : {}),
  });
  return { text: flags["--json"] ? JSON.stringify(result) : result.report.trimEnd(), code: 0 };
}
