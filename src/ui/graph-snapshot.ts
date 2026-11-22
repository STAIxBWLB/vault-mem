import { createHash } from "node:crypto";
import type { AnalysisSnapshot } from "../analysis-types.ts";
import { scalarText } from "../analysis-yaml.ts";
import { buildGraph, collectUnresolvedGraph, codePointCompare, graphFrontmatter, pythonTitle } from "../vault-graph.ts";
import type { GraphEdge } from "../vault-graph.ts";
import type { GraphSnapshotPage, GraphNodeColumns, GraphEdgeColumns } from "./panel-types.ts";

type NodeRow = { id: string; label: string; type: string | null; domain: string | null; source_file: string | null; community: number | null; degree: number; updated: string | null; date: string | null; placeholder: boolean; description: string | null; confidence: string | null; topics: string | null };
export type GraphEdgeRow = { source: number; target: number; relation: string; field: string | null; rel: string | null; confidence_tag: string; confidence: number };
export interface GraphSnapshotAssembly { vault: string; revision: string; pages: GraphSnapshotPage[] }
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
export function assembleGraphSnapshot(snapshot: AnalysisSnapshot, vault: string): GraphSnapshotAssembly {
  const graph = buildGraph(snapshot), unresolved = collectUnresolvedGraph(snapshot);
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of unresolved) { const list = grouped.get(edge.target) ?? []; list.push(edge); grouped.set(edge.target, list); }
  const notes = new Map(snapshot.notes.map(n => [n.path, n]));
  const nodes: NodeRow[] = graph.nodes.map(n => {
    const fm = graphFrontmatter(notes.get(n.source_file)!.source);
    return { ...n, description: n.description ?? null, confidence: n.confidence ?? null, topics: n.topics ?? null, updated: scalar(fm.updated), date: scalar(fm.created ?? fm.date), placeholder: false };
  });
  const extra: GraphEdge[] = [];
  let omitted = 0, full = false;
  for (const [id, edges] of grouped) {
    if (full || nodes.length >= MAX_NODES || graph.edges.length + extra.length + edges.length > MAX_EDGES) { full = true; omitted++; continue; }
    nodes.push({ id, label: pythonTitle(id.replaceAll("-", " ")), type: null, domain: null, source_file: null, community: null, degree: edges.length, updated: null, date: null, placeholder: true, description: null, confidence: null, topics: null });
    extra.push(...edges);
  }
  extra.sort((a, b) => codePointCompare(a.source, b.source) || codePointCompare(a.target, b.target));
  const indices = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: GraphEdgeRow[] = [...graph.edges, ...extra].map(e => ({ source: indices.get(e.source)!, target: indices.get(e.target)!, relation: e.relation, field: e.field ?? null, rel: e.rel ?? null, confidence_tag: e.confidence_tag, confidence: e.confidence }));
  const metadata = { directed: graph.directed, multigraph: graph.multigraph, ...graph.graph };
  const totals = { nodes: nodes.length, edges: edges.length, placeholders: nodes.length - graph.nodes.length, placeholdersOmitted: omitted };
  const revision = createHash("sha256").update(JSON.stringify([1, vault, metadata, totals, nodes, edges])).digest("hex");
  const pages: GraphSnapshotPage[] = [];
  const envelope = (kind: "nodes" | "edges", offset: number, count: number, columns: GraphNodeColumns | GraphEdgeColumns): GraphSnapshotPage => {
    const total = kind === "nodes" ? nodes.length : edges.length;
    const next = offset + count < total ? token(vault, revision, kind, offset + count)
      : kind === "nodes" && edges.length ? token(vault, revision, "edges", 0) : null;
    return { schema: 1, vault, revision, graph: metadata, totals, kind, offset, count, columns, next };
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
  return { vault, revision, pages };
}
