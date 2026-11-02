import { extractLinks } from "./links.ts";
import type { SpecDiagnostic, SpecDocument, SpecSnapshot } from "./spec-source.ts";

export const SPEC_EDGE_KINDS = ["parent", "depends-on", "references", "implements", "superseded-by", "body_link"] as const;
/** Pure transforms keep the discovery ceiling and bound resolved plus unresolved edges together. */
export const MAX_SPEC_INPUTS = 10000, MAX_SPEC_EDGES = 100000;
export type SpecEdgeKind = typeof SPEC_EDGE_KINDS[number];
export interface SpecNode { id: string; path: string; title: string; type: string; status?: string }
export interface SpecEdge { source: string; target: string; kind: SpecEdgeKind }
export interface SpecGraph {
  nodes: SpecNode[];
  edges: SpecEdge[];
  unresolved: SpecEdge[];
  diagnostics: SpecDiagnostic[];
}
export interface SpecSliceOptions {
  direction?: "subtree" | "ancestors" | "neighbors";
  depth?: number;
  limit?: number;
  edge?: SpecEdgeKind;
}
export interface SpecSlice { nodes: SpecNode[]; edges: SpecEdge[]; truncated: boolean }

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const pathOrder = (a: SpecDocument, b: SpecDocument): number => compare(a.path.normalize("NFC"), b.path.normalize("NFC")) || compare(a.path, b.path) || compare(a.id, b.id);
const edgeOrder = (a: SpecEdge, b: SpecEdge): number => compare(a.source, b.source) || SPEC_EDGE_KINDS.indexOf(a.kind) - SPEC_EDGE_KINDS.indexOf(b.kind) || compare(a.target, b.target);
/** Metadata wiki addresses use the same id/label/heading split as body links. */
export function specReference(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (!text.startsWith("[[") && !text.endsWith("]]")) return text;
  const wiki = /^\[\[([^\]\n]+)\]\]$/.exec(text);
  if (!wiki) return undefined;
  const address = wiki[1]!.split("|")[0]!, hash = address.indexOf("#");
  return (hash < 0 ? address : address.slice(0, hash)).trim() || undefined;
}

/** Build only the read graph: unknown types/statuses remain visible for the later validation pass. */
export function buildSpecGraph(snapshot: SpecSnapshot): SpecGraph {
  if (snapshot.specs.length > MAX_SPEC_INPUTS) throw new Error(`spec graph: more than ${MAX_SPEC_INPUTS} input specs; pass a smaller SpecSnapshot before building the graph`);
  const documents = new Map<string, SpecDocument>(), diagnostics = [...snapshot.diagnostics];
  for (const document of [...snapshot.specs].sort(pathOrder)) {
    const first = documents.get(document.id);
    if (first) {
      if (!diagnostics.some(item => item.code === "duplicate_id" && item.path === document.path && item.id === document.id)) diagnostics.push({
        code: "duplicate_id", path: document.path, id: document.id, firstPath: first.path,
        message: "duplicate spec id; give each spec a unique frontmatter id and rebuild the graph",
      });
      continue;
    }
    documents.set(document.id, document);
  }
  const nodes = [...documents.values()].map(document => ({
    id: document.id, path: document.path,
    title: typeof document.frontmatter.title === "string" ? document.frontmatter.title : document.id,
    type: typeof document.frontmatter.type === "string" ? document.frontmatter.type : "",
    ...(typeof document.frontmatter.status === "string" ? { status: document.frontmatter.status } : {}),
  })).sort((a, b) => compare(a.id, b.id));
  const edges: SpecEdge[] = [], unresolved: SpecEdge[] = [];
  const seenEdges = new Map<string, Map<SpecEdgeKind, Set<string>>>();
  const add = (source: string, value: unknown, kind: SpecEdgeKind) => {
    const target = specReference(value);
    if (!target) return false;
    let kinds = seenEdges.get(source);
    if (!kinds) seenEdges.set(source, kinds = new Map());
    let targets = kinds.get(kind);
    if (!targets) kinds.set(kind, targets = new Set());
    if (targets.has(target)) return true;
    if (edges.length + unresolved.length >= MAX_SPEC_EDGES) throw new Error(`spec graph: more than ${MAX_SPEC_EDGES} unique edges; reduce link lists or pass a smaller SpecSnapshot before rebuilding`);
    targets.add(target);
    const collection = documents.has(target) ? edges : unresolved;
    collection.push({ source, target, kind });
    return true;
  };
  for (const document of documents.values()) {
    const wrongShape = (field: string) => diagnostics.push({ code: "wrong_shape", path: document.path, id: document.id, field, message: "frontmatter link has the wrong shape; use one link for parent/superseded-by and a list for dependency/reference/implementation links" });
    for (const kind of ["parent", "superseded-by"] as const) if (document.frontmatter[kind] !== undefined && !add(document.id, document.frontmatter[kind], kind)) wrongShape(kind);
    for (const kind of ["depends-on", "references", "implements"] as const) {
      const values = document.frontmatter[kind];
      if (values === undefined) continue;
      if (!Array.isArray(values)) { wrongShape(kind); continue; }
      let invalid = false;
      for (const value of values) if (!add(document.id, value, kind)) invalid = true;
      if (invalid) wrongShape(kind);
    }
    for (const link of extractLinks(document.body)) add(document.id, link.target, "body_link");
  }
  diagnostics.sort((a, b) => compare(a.path.normalize("NFC"), b.path.normalize("NFC")) || compare(a.path, b.path) || compare(a.code, b.code));
  return { nodes, edges: edges.sort(edgeOrder), unresolved: unresolved.sort(edgeOrder), diagnostics };
}

/** A deterministic BFS; parent edges point child -> parent, while subtree traversal reverses them. */
export function specSlice(graph: SpecGraph, id: string, options: SpecSliceOptions = {}): SpecSlice {
  const direction = options.direction ?? "subtree", depth = options.depth ?? 1, limit = options.limit ?? 50;
  if (!["subtree", "ancestors", "neighbors"].includes(direction)) throw new Error("spec slice: invalid direction; choose subtree, ancestors or neighbors");
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error("spec slice: depth must be an integer from 0 to 3; pass a smaller depth");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("spec slice: limit must be an integer from 1 to 500; pass a valid node limit");
  if (options.edge !== undefined && !SPEC_EDGE_KINDS.includes(options.edge)) throw new Error("spec slice: unknown edge kind; choose a kind from SPEC_EDGE_KINDS");
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (typeof id !== "string" || !nodes.has(id)) throw new Error("spec slice: unknown spec id; select an id from buildSpecGraph(...).nodes");
  const edge = options.edge ?? (direction === "neighbors" ? undefined : "parent");
  const edges = graph.edges.filter(item => (edge === undefined || item.kind === edge) && nodes.has(item.source) && nodes.has(item.target));
  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    let neighbors = adjacency.get(from);
    if (!neighbors) adjacency.set(from, neighbors = new Set());
    neighbors.add(to);
  };
  for (const item of edges) {
    if (direction === "ancestors" || direction === "neighbors") add(item.source, item.target);
    if (direction === "subtree" || direction === "neighbors") add(item.target, item.source);
  }
  const selected = new Set([id]), queue: { id: string; depth: number }[] = [{ id, depth: 0 }];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (const neighbor of [...(adjacency.get(current.id) ?? [])].sort(compare)) {
      if (selected.has(neighbor)) continue;
      if (current.depth >= depth || selected.size >= limit) continue;
      selected.add(neighbor); queue.push({ id: neighbor, depth: current.depth + 1 });
    }
  }
  const truncated = [...selected].some(node => [...(adjacency.get(node) ?? [])].some(neighbor => !selected.has(neighbor)));
  return {
    nodes: graph.nodes.filter(node => selected.has(node.id)).sort((a, b) => compare(a.id, b.id)),
    edges: edges.filter(item => selected.has(item.source) && selected.has(item.target)).sort(edgeOrder),
    truncated,
  };
}
