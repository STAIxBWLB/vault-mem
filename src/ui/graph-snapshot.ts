import { createHash } from "node:crypto";
import type { AnalysisSnapshot } from "../analysis-types.ts";
import { scalarText } from "../analysis-yaml.ts";
import { buildGraph, collectUnresolvedGraph, collectSupersedesEdges, codePointCompare, graphFrontmatter, pythonTitle } from "../vault-graph.ts";
import type { GraphEdge } from "../vault-graph.ts";
import type { GraphSnapshotPage, GraphNodeColumns, GraphEdgeColumns, SemanticGraphPage } from "./panel-types.ts";

type NodeRow = { id: string; label: string; type: string | null; domain: string | null; source_file: string | null; community: number | null; degree: number; updated: string | null; date: string | null; placeholder: boolean; description: string | null; confidence: string | null; topics: string | null };
export type GraphEdgeRow = { source: number; target: number; relation: string; field: string | null; rel: string | null; confidence_tag: string; confidence: number };
export interface GraphEnrichmentInputs { model: string | null; embedded: number; total: number; digest: string; vectors: { path: string; values: number[] }[] }
export interface GraphSnapshotAssembly { vault: string; revision: string; pages: GraphSnapshotPage[]; enrichment?: GraphEnrichmentInputs }
const MAX_BYTES = 1_048_576 - 32;
const MAX_NODES = 10_000, MAX_EDGES = 100_000;
const scalar = (v: unknown): string | null => scalarText(v) ?? (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : null);
const token = (vault: string, revision: string, kind: string, offset: number): string => Buffer.from(JSON.stringify([1, vault, revision, kind, offset])).toString("base64url");
export const encodeGraphPage = (assembly: GraphSnapshotAssembly, page: GraphSnapshotPage): string => token(assembly.vault, assembly.revision, page.kind, page.offset);
export function resolveGraphPage(assembly: GraphSnapshotAssembly, page?: string): GraphSnapshotPage {
  if (page === undefined) return assembly.pages[0]!;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(page, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== 1 || decoded[1] !== assembly.vault || decoded[2] !== assembly.revision || (decoded[3] !== "nodes" && decoded[3] !== "edges") || !Number.isSafeInteger(decoded[4]) || decoded[4] < 0 || token(decoded[1], decoded[2], decoded[3], decoded[4]) !== page) throw new Error();
    const found = assembly.pages.find(p => p.kind === decoded[3] && p.offset === decoded[4]);
    if (found) return found;
  } catch { /* Invalid tokens all receive the same refusal. */ }
  throw new Error("graph page is invalid or expired; restart from the first page");
}
function nodeColumns(rows: NodeRow[]): GraphNodeColumns {
  return { id: rows.map(r => r.id), label: rows.map(r => r.label), type: rows.map(r => r.type), domain: rows.map(r => r.domain), source_file: rows.map(r => r.source_file), community: rows.map(r => r.community), degree: rows.map(r => r.degree), updated: rows.map(r => r.updated), date: rows.map(r => r.date), placeholder: rows.map(r => r.placeholder), description: rows.map(r => r.description), confidence: rows.map(r => r.confidence), topics: rows.map(r => r.topics) };
}
export function graphEdgeColumns(rows: GraphEdgeRow[]): GraphEdgeColumns {
  const relations = [...new Set(rows.map(r => r.relation))], tags = rows.map(r => r.confidence_tag), confidence = rows.map(r => r.confidence);
  return { source: rows.map(r => r.source), target: rows.map(r => r.target), relations, relation: rows.map(r => relations.indexOf(r.relation)), field: rows.map(r => r.field), rel: rows.map(r => r.rel), confidence_tag: tags.every(t => t === tags[0]) ? tags[0] ?? [] : tags, confidence: confidence.every(c => c === confidence[0]) ? confidence[0] ?? [] : confidence };
}
export function assembleGraphSnapshot(snapshot: AnalysisSnapshot, vault: string, enrichment?: GraphEnrichmentInputs): GraphSnapshotAssembly {
  const graph = buildGraph(snapshot), ids = new Set(graph.nodes.map(node => node.id));
  const supersedes = collectSupersedesEdges(snapshot), resolved = supersedes.filter(edge => ids.has(edge.target));
  if (graph.edges.length + resolved.length > MAX_EDGES) throw new Error(`graph: exceeds ${MAX_EDGES} edges`);
  const unresolved = [...collectUnresolvedGraph(snapshot), ...supersedes.filter(edge => !ids.has(edge.target))];
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of unresolved) { const list = grouped.get(edge.target) ?? []; list.push(edge); grouped.set(edge.target, list); }
  const notes = new Map(snapshot.notes.map(n => [n.path.replace(/^notes\//, "").slice(0, -3), n]));
  const nodes: NodeRow[] = graph.nodes.map(n => {
    const fm = graphFrontmatter(notes.get(n.id)!.source);
    return { ...n, description: n.description || null, confidence: n.confidence || null, topics: n.topics || null, updated: scalar(fm.updated), date: scalar(fm.created) ?? scalar(fm.date), placeholder: false };
  });
  const extra: GraphEdge[] = [];
  let omitted = 0, full = false;
  for (const [id, edges] of [...grouped].sort(([a], [b]) => codePointCompare(a, b))) {
    if (full || nodes.length >= MAX_NODES || graph.edges.length + resolved.length + extra.length + edges.length > MAX_EDGES) { full = true; omitted++; continue; }
    nodes.push({ id, label: pythonTitle(id.replaceAll("-", " ")), type: null, domain: null, source_file: null, community: null, degree: edges.length, updated: null, date: null, placeholder: true, description: null, confidence: null, topics: null });
    extra.push(...edges);
  }
  extra.sort((a, b) => codePointCompare(a.source, b.source) || codePointCompare(a.target, b.target));
  const indices = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: GraphEdgeRow[] = [...graph.edges, ...resolved, ...extra].map(e => ({ source: indices.get(e.source)!, target: indices.get(e.target)!, relation: e.relation, field: e.field ?? null, rel: e.rel ?? null, confidence_tag: e.confidence_tag, confidence: e.confidence }));
  const metadata = { directed: graph.directed, multigraph: graph.multigraph, ...graph.graph };
  const totals = { nodes: nodes.length, edges: edges.length, placeholders: nodes.length - graph.nodes.length, placeholdersOmitted: omitted };
  const revision = createHash("sha256").update(JSON.stringify([1, vault, metadata, totals, nodes, edges, ...(enrichment ? [enrichment.digest] : [])])).digest("hex");
  const pages: GraphSnapshotPage[] = [];
  const envelope = (kind: "nodes" | "edges", offset: number, count: number, columns: GraphNodeColumns | GraphEdgeColumns): GraphSnapshotPage => {
    const total = kind === "nodes" ? nodes.length : edges.length;
    const next = offset + count < total ? token(vault, revision, kind, offset + count)
      : kind === "nodes" && edges.length ? token(vault, revision, "edges", 0) : null;
    return { schema: 1, vault, revision, graph: metadata, totals, kind, offset, count, columns, next, ...(enrichment && kind === "nodes" && offset === 0 ? { enrichment: { model: enrichment.model, embedded: enrichment.embedded, total: enrichment.total } } : {}) };
  };
  // Binary search each page boundary: every candidate is measured before its rows are accepted.
  function paginate<T>(kind: "nodes" | "edges", rows: T[], columns: (items: T[]) => GraphNodeColumns | GraphEdgeColumns): void {
    let offset = 0;
    while (offset < rows.length || (kind === "nodes" && !pages.length)) {
      let low = 0, high = rows.length - offset;
      const all = envelope(kind, offset, high, columns(rows.slice(offset)));
      if (Buffer.byteLength(JSON.stringify(all)) <= MAX_BYTES) { pages.push(all); break; }
      if (!high) throw new Error("graph page envelope exceeds the page budget; shorten the vault id and retry");
      // The last page can be smaller because it has no next token; it was checked above.
      high--;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2), candidate = envelope(kind, offset, mid, columns(rows.slice(offset, offset + mid)));
        if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_BYTES) low = mid; else high = mid - 1;
      }
      if (!low && rows.length > offset) {
        const row = rows[offset] as NodeRow | GraphEdgeRow;
        const id = "id" in row ? row.id : nodes[row.source]?.id ?? "unknown";
        throw new Error(`graph row ${id.slice(0, 80)} exceeds the page budget; shorten its metadata and retry`);
      }
      pages.push(envelope(kind, offset, low, columns(rows.slice(offset, offset + low))));
      offset += low;
      if (!low) break;
    }
  }
  paginate("nodes", nodes, nodeColumns); paginate("edges", edges, graphEdgeColumns);
  return { vault, revision, pages, ...(enrichment ? { enrichment } : {}) };
}

/** Exact undirected union of each note's top-k cosine neighbors. Vectors remain in process. */
export function assembleSemanticPages(assembly: GraphSnapshotAssembly, k: number, minScore: number): SemanticGraphPage[] {
  if (!Number.isInteger(k) || k < 1 || k > 20 || typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1)
    throw new Error("graph semantic: k must be 1..20 and minScore must be 0..1; correct the parameters and restart");
  if (!assembly.enrichment) throw new Error("enrichment: enrichment is disabled; enable it in settings");
  const ids = new Map<string, number>();
  for (const page of assembly.pages) if (page.kind === "nodes") {
    const columns = page.columns as GraphNodeColumns;
    columns.source_file.forEach((path, i) => { if (path) ids.set(path.slice(6), page.offset + i); });
  }
  const vectors = assembly.enrichment.vectors.flatMap(item => {
    const index = ids.get(item.path); if (index === undefined) return [];
    let scale = 0; for (const v of item.values) scale = Math.max(scale, Math.abs(v));
    let norm = 0; for (const v of item.values) norm += (v / scale) ** 2;
    norm = Math.sqrt(norm);
    return [{ index, vector: Float64Array.from(item.values, v => v / scale / norm) }];
  }).sort((a, b) => a.index - b.index);
  const tops: { index: number; score: number }[][] = vectors.map(() => []);
  const insert = (list: { index: number; score: number }[], index: number, score: number) => {
    let at = 0;
    while (at < list.length && (list[at]!.score > score || (list[at]!.score === score && list[at]!.index < index))) at++;
    if (at >= k) return;
    list.splice(at, 0, { index, score }); if (list.length > k) list.pop();
  };
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) {
    const left = vectors[i]!.vector, right = vectors[j]!.vector;
    let score = 0; for (let d = 0; d < left.length; d++) score += left[d]! * right[d]!;
    score = Math.max(-1, Math.min(1, score));
    if (score >= minScore) { insert(tops[i]!, j, score); insert(tops[j]!, i, score); }
  }
  const unique = new Map<string, { source: number; target: number; score: number }>();
  tops.forEach((list, i) => { for (const item of list) {
    const source = Math.min(vectors[i]!.index, vectors[item.index]!.index), target = Math.max(vectors[i]!.index, vectors[item.index]!.index);
    unique.set(`${source}:${target}`, { source, target, score: item.score });
  } });
  const rows = [...unique.values()].sort((a, b) => a.source - b.source || a.target - b.target);
  const encode = (offset: number) => Buffer.from(JSON.stringify([1, assembly.vault, assembly.revision, "semantic", k, minScore, offset])).toString("base64url");
  const make = (offset: number, count: number): SemanticGraphPage => {
    const slice = rows.slice(offset, offset + count);
    return { schema: 1, vault: assembly.vault, revision: assembly.revision, kind: "semantic", offset, count, semantic: { source: slice.map(r => r.source), target: slice.map(r => r.target), score: slice.map(r => r.score) }, next: offset + count < rows.length ? encode(offset + count) : null };
  };
  const pages: SemanticGraphPage[] = []; let offset = 0;
  do {
    let low = 0, high = rows.length - offset;
    if (Buffer.byteLength(JSON.stringify(make(offset, high))) <= MAX_BYTES) { pages.push(make(offset, high)); break; }
    high--;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(make(offset, mid))) <= MAX_BYTES) low = mid; else high = mid - 1; }
    if (!low) throw new Error("graph semantic: page exceeds the byte budget; reduce the vault id and restart");
    pages.push(make(offset, low)); offset += low;
  } while (offset < rows.length);
  return pages;
}
export function resolveSemanticPage(assembly: GraphSnapshotAssembly, pages: SemanticGraphPage[], k: number, minScore: number, page?: string): SemanticGraphPage {
  if (page === undefined) return pages[0]!;
  try {
    const value: unknown = JSON.parse(Buffer.from(page, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 7 || value[0] !== 1 || value[1] !== assembly.vault || value[2] !== assembly.revision || value[3] !== "semantic" || value[4] !== k || value[5] !== minScore || !Number.isSafeInteger(value[6]) || value[6] < 0 || Buffer.from(JSON.stringify(value)).toString("base64url") !== page) throw new Error();
    const found = pages.find(p => p.offset === value[6]); if (found) return found;
  } catch { /* All invalid tokens get the same recovery instruction. */ }
  throw new Error("graph semantic page is invalid or expired; restart from the first page");
}
