import { AnalysisYamlScalar, parseAnalysisYaml, yamlTruthy } from "./analysis-yaml.ts";
import type { AnalysisSnapshot } from "./analysis-types.ts";
import { buildGraph, finalizeGraph, pythonTitle, pyString, type GraphNode, type GraphEdge, type VaultGraph } from "./vault-graph.ts";
import { posix } from "node:path";

export interface WorkspaceSnapshot {
  files: { path: string; text: string }[];
  buSlugs: string[];
  skipRoots: string[];
  assertUnchanged?: () => void;
  sourceTargets: Record<string, "file" | "directory" | "missing" | "denied">;
}
export const WORK_SKIP_DIRS = new Set([".git", "node_modules", ".venv", ".sync-conflicts", "temp", ".maru", ".pnpm-store", ".conductor", ".dotfiles", ".omx", ".omc", ".gstack", ".frontend-slides", ".claude", ".archive", "archive", "vault", "inbox", "sites", "dev", "shared", "_templates", "templates"]);
const FIELDS = ["projects", "project", "vault_note", "topics", "attendees", "relatedMeetings", "relatedTasks"];
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const WIKI = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
const PRIORITY = { wiki_link: 0, fm_ref: 1, bu_member: 2, source_ref: 3, related: 4, supersedes: 5 };
export type WorkCounters = Record<"work_docs" | "yaml_fail" | "template_skip" | "related_unresolved" | "related_ambiguous" | "related_dir_skip" | "related_root_escape" | "related_home_escape" | "source_stub" | "source_dead" | "source_nonmd" | "source_skiproot" | "collisions" | "dup_edges", number>;
export function workSkipped(path: string, roots: string[]): boolean {
  const normalized = path.normalize("NFC").replace(/^\/+|\/+$/g, "");
  return roots.some(root => normalized === root || normalized.startsWith(root + "/"));
}
function mapping(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof AnalysisYamlScalar); }
export function workspaceFrontmatter(text: string): Record<string, unknown> {
  const match = FRONTMATTER.exec(text);
  if (!match) return {};
  try { const value = parseAnalysisYaml(match[1]!); return mapping(value) ? value : {}; }
  catch { return {}; } // The reference skips rejected YAML and counts work-doc failures.
}
function links(value: unknown): string[] { return [...pyString(value).matchAll(WIKI)].map(match => match[1]!.trim().normalize("NFC").toLowerCase().replaceAll(" ", "-")); }
function coerce(value: unknown): string {
  return value instanceof AnalysisYamlScalar && value.kind === "timestamp" ? value.text.replace(" ", "T") : pyString(value);
}
function label(path: string): string {
  let stem = posix.basename(path, ".md").normalize("NFC");
  const parent = posix.basename(posix.dirname(path));
  if (["readme", "index"].includes(stem.toLowerCase()) && parent !== ".") stem = parent + "-" + stem;
  return pythonTitle(stem.replaceAll("-", " "));
}
/** Reference source spelling: keep its ID spelling, including path segments, rather than silently remap it. */
export function workspaceSource(fm: Record<string, unknown>): string | undefined {
  if (typeof fm.source !== "string" || !fm.source.trim()) return undefined;
  let raw = fm.source.trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  if (!raw || raw.startsWith("http://") || raw.startsWith("https://")) return undefined;
  if (raw.startsWith("work/")) raw = raw.slice(5);
  return raw.normalize("NFC");
}
export function buildWorkspaceGraph(snapshot: AnalysisSnapshot, work: WorkspaceSnapshot): { graph: VaultGraph; counters: WorkCounters; relations: Record<string, number> } {
  const graph = buildGraph(snapshot);
  const counters: WorkCounters = { work_docs: 0, yaml_fail: 0, template_skip: 0, related_unresolved: 0, related_ambiguous: 0, related_dir_skip: 0, related_root_escape: 0, related_home_escape: 0, source_stub: 0, source_dead: 0, source_nonmd: 0, source_skiproot: 0, collisions: 0, dup_edges: 0 };
  const vaultIds = new Set(graph.nodes.map(node => node.id));
  const docs = new Map<string, { path: string; fm: Record<string, unknown>; body: string }>(), stems = new Map<string, string[]>();
  for (const file of work.files) {
    const match = FRONTMATTER.exec(file.text);
    if (!match) continue;
    if (match[1]!.includes("{{")) { counters.template_skip++; continue; }
    const fm = workspaceFrontmatter(file.text);
    if (!Object.keys(fm).length) { if (match[1]!.trim()) counters.yaml_fail++; continue; }
    if (!yamlTruthy(fm.document_type) && !FIELDS.some(field => yamlTruthy(fm[field])) && !yamlTruthy(fm.related)) continue;
    const path = file.path.normalize("NFC"), id = "work:" + path.slice(0, -3);
    docs.set(id, { path, fm, body: file.text.slice(match[0].length) });
    const key = posix.basename(path, ".md").toLowerCase().replaceAll(" ", "-");
    stems.set(key, [...stems.get(key) ?? [], id]); counters.work_docs++;
  }
  const validBu = new Set(work.buSlugs), usedBu = new Set<string>();
  const businessUnit = (fm: Record<string, unknown>) => pyString(fm.business_unit ?? "").replaceAll("[[", "").replaceAll("]]", "").trim();
  for (const doc of docs.values()) { const bu = businessUnit(doc.fm); if (validBu.has(bu)) usedBu.add(bu); }
  const node = (value: Omit<GraphNode, "degree" | "community">): GraphNode => ({ ...value, degree: 0, community: null });
  for (const slug of [...usedBu].sort()) graph.nodes.push(node({ id: "bu:" + slug, type: "bu", domain: "bu", label: slug, source_file: "" }));
  for (const [id, doc] of docs) graph.nodes.push(node({ id, label: label(doc.path), type: coerce(yamlTruthy(doc.fm.document_type) ? doc.fm.document_type : "work-doc"), domain: doc.path.split("/")[0]!, description: Array.from(coerce(yamlTruthy(doc.fm.title) ? doc.fm.title : yamlTruthy(doc.fm.description) ? doc.fm.description : "")).slice(0, 200).join(""), source_file: doc.path }));
  if (graph.nodes.length > 20000) throw new Error("workspace graph: exceeds 20000 nodes");
  const candidates: GraphEdge[] = [];
  const add = (relation: GraphEdge["relation"], source: string, target: string, attrs: { rel?: string; field?: string } = {}) => {
    if (candidates.length >= 200000) throw new Error("workspace graph: exceeds 200000 edge candidates");
    candidates.push({ source, target, relation, confidence_tag: "EXTRACTED", confidence: 1, ...attrs });
  };
  for (const [id, doc] of docs) {
    const related = doc.fm.related;
    if (related !== null && related !== undefined) for (const entry of Array.isArray(related) ? related : [related]) {
      const rtype = mapping(entry) ? entry.rel : undefined;
      let value = pyString(mapping(entry) ? entry.doc ?? "" : entry).trim();
      if (!value) continue;
      value = value.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const wiki = links(value);
      let target: string | undefined;
      if (wiki.length) {
        const targets = stems.get(wiki[0]!);
        if (!targets?.length) counters.related_unresolved++;
        else if (targets.length > 1) counters.related_ambiguous++;
        else target = targets[0];
      } else if (value.startsWith("~")) counters.related_home_escape++;
      else {
        const joined = posix.isAbsolute(value) ? posix.normalize(value) : posix.normalize(posix.join(posix.dirname(doc.path), value));
        if (joined.startsWith("..")) counters.related_root_escape++;
        else if (value.endsWith("/") || !joined.endsWith(".md")) counters.related_dir_skip++;
        else if (docs.has("work:" + joined.slice(0, -3))) target = "work:" + joined.slice(0, -3);
        else counters.related_unresolved++;
      }
      if (target) add("related", id, target, yamlTruthy(rtype) ? { rel: coerce(rtype) } : {});
    }
    for (const field of FIELDS) if (field in doc.fm) for (const key of links(doc.fm[field])) if (vaultIds.has(key)) add("fm_ref", id, key, { field });
    for (const key of links(doc.body)) if (vaultIds.has(key)) add("wiki_link", id, key);
    const bu = businessUnit(doc.fm); if (usedBu.has(bu)) add("bu_member", id, "bu:" + bu);
  }
  const stubs = new Set<string>();
  for (const note of [...snapshot.notes].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const fm = workspaceFrontmatter(note.source), id = posix.basename(note.path, ".md"), raw = workspaceSource(fm);
    if (raw !== undefined) {
      const ext = posix.extname(raw), norm = raw.endsWith(".md") ? raw.slice(0, -3) : raw, target = "work:" + norm;
      if (raw.endsWith("/") || (ext && ext !== ".md")) counters.source_nonmd++;
      else if (docs.has(target)) add("source_ref", id, target);
      else if (norm.split("/").some(part => WORK_SKIP_DIRS.has(part)) || workSkipped(norm, work.skipRoots) || work.sourceTargets[norm] === "denied") counters.source_skiproot++;
      else if (work.sourceTargets[norm] === "file") {
        if (!stubs.has(target)) { stubs.add(target); counters.source_stub++; graph.nodes.push(node({ id: target, type: "file", label: label(norm + ".md"), domain: norm.split("/")[0]!, source_file: norm + ".md" })); }
        add("source_ref", id, target);
      } else if (work.sourceTargets[norm] === "directory") counters.source_nonmd++;
      else counters.source_dead++;
    }
    for (const field of ["supersedes", "superseded_by"]) if (yamlTruthy(fm[field])) for (const key of links(fm[field])) if (vaultIds.has(key)) add("supersedes", id, key, { field });
  }
  const known = new Set(graph.nodes.map(node => node.id)), best = new Map<string, GraphEdge>();
  const pair = (edge: GraphEdge) => JSON.stringify([edge.source, edge.target].sort());
  for (const edge of candidates) {
    if (edge.source === edge.target || !known.has(edge.source) || !known.has(edge.target)) continue;
    const key = pair(edge), current = best.get(key);
    if (current) {
      if (current.relation !== edge.relation) counters.collisions++; else counters.dup_edges++;
    }
    if (!current || PRIORITY[edge.relation] > PRIORITY[current.relation]) best.set(key, edge);
  }
  const edges = new Map(graph.edges.map(edge => [pair(edge), edge]));
  for (const [key, edge] of best) edges.set(key, { ...edges.get(key), ...edge });
  graph.edges = [...edges.values()];
  if (graph.nodes.length > 20000 || graph.edges.length > 100000) throw new Error("workspace graph: node or edge bound exceeded");
  finalizeGraph(graph);
  const relations: Record<string, number> = {};
  for (const edge of graph.edges) relations[edge.relation] = (relations[edge.relation] ?? 0) + 1;
  return { graph, counters, relations };
}
