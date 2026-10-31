import type { AnalysisSnapshot } from "./analysis-types.ts";
import { AnalysisYamlUnsupported, parseAnalysisYaml, scalarText, yamlTruthy } from "./analysis-yaml.ts";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  domain: string;
  description?: string;
  confidence?: string;
  source_file: string;
  topics?: string;
  community: number | null;
  degree: number;
}
export interface GraphEdge { source: string; target: string; relation: "wiki_link" | "fm_ref" | "bu_member" | "source_ref" | "related" | "supersedes"; field?: string; rel?: string; confidence_tag: "EXTRACTED"; confidence: 1 }
export interface VaultGraph {
  directed: false;
  multigraph: false;
  graph: { partitioner: "leiden"; resolution: number; modularity: number; iterations: number; max_iterations: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphNeighborhood { start: string; hops: 1 | 2; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
/** Bound on Leiden levels summed over refinement rounds (`MAX_LEVELS` × `MAX_ROUNDS`). */
const MAX_ITERATIONS = 32 * 8;
const MAX_NODES = 10000;
const MAX_EDGES = 100000;
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const HUB_TYPES = new Set(["moc", "bu"]);
/** Python sorts Unicode strings by code point, independently of the host locale. */
function compare(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
const TITLE_SPECIAL: Record<string, string> = {
  "ŉ": "ʼN", "Ǆ": "ǅ", "ǅ": "ǅ", "ǆ": "ǅ", "Ǉ": "ǈ", "ǈ": "ǈ", "ǉ": "ǈ",
  "Ǌ": "ǋ", "ǋ": "ǋ", "ǌ": "ǋ", "Ǳ": "ǲ", "ǲ": "ǲ", "ǳ": "ǲ",
  "ᾲ": "Ὰͅ", "ᾳ": "ᾼ", "ᾴ": "Άͅ", "ᾷ": "ᾼ͂", "ᾼ": "ᾼ",
  "ῂ": "Ὴͅ", "ῃ": "ῌ", "ῄ": "Ήͅ", "ῇ": "ῌ͂", "ῌ": "ῌ",
  "ῲ": "Ὼͅ", "ῳ": "ῼ", "ῴ": "Ώͅ", "ῷ": "ῼ͂", "ῼ": "ῼ",
};
const GREEK_LOWER = Array.from("ᾀᾁᾂᾃᾄᾅᾆᾇᾐᾑᾒᾓᾔᾕᾖᾗᾠᾡᾢᾣᾤᾥᾦᾧ");
const GREEK_TITLE = Array.from("ᾈᾉᾊᾋᾌᾍᾎᾏᾘᾙᾚᾛᾜᾝᾞᾟᾨᾩᾪᾫᾬᾭᾮᾯ");
function titleCharacter(character: string): string {
  if (Object.hasOwn(TITLE_SPECIAL, character)) return TITLE_SPECIAL[character]!;
  const greek = GREEK_LOWER.indexOf(character);
  if (greek !== -1) return GREEK_TITLE[greek]!;
  if (GREEK_TITLE.includes(character) || /[ა-ჺჽ-ჿ]/u.test(character)) return character;
  const upper = Array.from(character.toUpperCase());
  return upper[0]! + upper.slice(1).join("").toLowerCase();
}
/** Like str.title(), apostrophes, digits and combining marks reset the word. */
export function pythonTitle(value: string): string {
  let previousCased = false, out = "";
  const characters = Array.from(value);
  for (let i = 0; i < characters.length; i++) {
    const character = characters[i]!;
    let lower = character.toLowerCase();
    if (character === "Σ") {
      const before = characters.slice(0, i).filter(item => !/\p{Case_Ignorable}/u.test(item)).at(-1);
      const after = characters.slice(i + 1).find(item => !/\p{Case_Ignorable}/u.test(item));
      if (before !== undefined && /\p{Cased}/u.test(before) && (after === undefined || !/\p{Cased}/u.test(after))) lower = "ς";
    }
    out += previousCased ? lower : titleCharacter(character);
    previousCased = /\p{Cased}/u.test(character);
  }
  return out;
}
function mapping(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function truthy(value: unknown): boolean {
  return yamlTruthy(value);
}
export function pyString(value: unknown): string {
  const scalar = scalarText(value);
  if (scalar !== undefined) return scalar;
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (mapping(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  return String(value);
}
function pyRepr(value: unknown): string {
  if (typeof value !== "string") return pyString(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return quote + value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`).replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t") + quote;
}
function parse(source: string): { fm: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) return { fm: {}, body: source };
  try {
    const value: unknown = parseAnalysisYaml(match[1]!);
    if (mapping(value) && Object.keys(value).length) return { fm: value, body: source.slice(match[0].length) };
  } catch (error) {
    if (error instanceof AnalysisYamlUnsupported) throw error;
    // The reference falls back to its original line parser for invalid YAML.
  }
  const fm: Record<string, unknown> = {};
  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.trim(), colon = line.indexOf(":");
    if (!line || line.startsWith("#") || colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') || value.startsWith("'")) && value.at(-1) === value[0]) value = value.slice(1, -1);
    fm[key] = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").filter(item => item.trim()).map(item => item.trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, ""))
      : value;
  }
  return { fm, body: source.slice(match[0].length) };
}
function adjacency(graph: Pick<VaultGraph, "nodes" | "edges">): Map<string, Set<string>> {
  const neighbors = new Map(graph.nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of graph.edges) { neighbors.get(edge.source)?.add(edge.target); neighbors.get(edge.target)?.add(edge.source); }
  return neighbors;
}
/** Leiden over the graph's own nodes and edges, with MOC/bu hubs excluded; writes `community` and the method metadata. */
function communities(graph: VaultGraph): void {
  const exclude = new Set(graph.nodes.filter(node => HUB_TYPES.has(node.type)).map(node => node.id));
  const result = leidenCommunities(graph.nodes.map(node => node.id), graph.edges.map(edge => [edge.source, edge.target] as const), { exclude });
  for (const node of graph.nodes) node.community = result.membership.get(node.id) ?? null;
  graph.graph = { partitioner: "leiden", resolution: result.resolution, modularity: result.modularity, iterations: result.levels, max_iterations: MAX_ITERATIONS };
}

// ── Leiden (Traag, Waltman, van Eck 2019), modularity, deterministic ─────────────────────────────

/** Resolution γ of the modularity objective. */
export const LEIDEN_RESOLUTION = 1;
const MAX_LEVELS = 32, MAX_ROUNDS = 8;
interface WeightedGraph { n: number; start: Int32Array; to: Int32Array; weight: Float64Array; self: Float64Array; strength: Float64Array; m2: number }
function weightedGraph(n: number, pairs: Map<number, number>, self: Float64Array): WeightedGraph {
  const degree = new Int32Array(n);
  for (const key of pairs.keys()) { degree[Math.floor(key / n)]!++; degree[key % n]!++; }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i]! + degree[i]!;
  const to = new Int32Array(start[n]!), weight = new Float64Array(start[n]!), fill = start.slice(0, n), strength = new Float64Array(n);
  // Keys are visited in ascending order so every adjacency list is sorted by neighbor index.
  for (const key of [...pairs.keys()].sort((a, b) => a - b)) {
    const a = Math.floor(key / n), b = key % n, w = pairs.get(key)!;
    to[fill[a]!] = b; weight[fill[a]!++] = w; to[fill[b]!] = a; weight[fill[b]!++] = w;
    strength[a]! += w; strength[b]! += w;
  }
  let m2 = 0;
  for (let i = 0; i < n; i++) { strength[i]! += 2 * self[i]!; m2 += strength[i]!; }
  return { n, start, to, weight, self, strength, m2 };
}
/**
 * Fast local moving (queue). Gains are compared as `k_in·2m − γ·k_v·K_C`, exact in floating point for integer weights.
 * Ties keep the current community, then take the lowest community id. Returns whether any node moved.
 */
function moveNodes(g: WeightedGraph, comm: Int32Array, gamma: number): boolean {
  const { n, start, to, weight, strength, m2 } = g;
  const total = new Float64Array(n), size = new Int32Array(n);
  for (let i = 0; i < n; i++) { total[comm[i]!]! += strength[i]!; size[comm[i]!]!++; }
  const empty: number[] = [];
  for (let c = n - 1; c >= 0; c--) if (!size[c]) empty.push(c);
  const queue = new Int32Array(n), queued = new Uint8Array(n), neighbor = new Float64Array(n), seen = new Uint8Array(n), touched: number[] = [];
  for (let i = 0; i < n; i++) { queue[i] = i; queued[i] = 1; }
  let head = 0, count = n, moved = false;
  while (count > 0) {
    const v = queue[head]!; head = (head + 1) % n; count--; queued[v] = 0;
    const own = comm[v]!, kv = strength[v]!;
    for (let e = start[v]!; e < start[v + 1]!; e++) {
      const c = comm[to[e]!]!;
      if (!seen[c]) { seen[c] = 1; touched.push(c); }
      neighbor[c]! += weight[e]!;
    }
    total[own]! -= kv; size[own]!--;
    let best = own, bestScore = neighbor[own]! * m2 - gamma * kv * total[own]!;
    for (const c of touched) {
      if (c === own) continue;
      const score = neighbor[c]! * m2 - gamma * kv * total[c]!;
      if (score > bestScore || (score === bestScore && best !== own && c < best)) { best = c; bestScore = score; }
    }
    if (bestScore < 0 && size[own]! > 0) { best = empty.pop()!; bestScore = 0; }
    comm[v] = best; total[best]! += kv; size[best]!++;
    if (!size[own]) empty.push(own);
    if (best !== own) {
      moved = true;
      for (let e = start[v]!; e < start[v + 1]!; e++) {
        const u = to[e]!;
        if (comm[u] !== best && !queued[u]) { queue[(head + count) % n] = u; queued[u] = 1; count++; }
      }
    }
    for (const c of touched) { neighbor[c] = 0; seen[c] = 0; }
    touched.length = 0;
  }
  return moved;
}
/**
 * Refinement inside each community of `comm`, merging only well-connected singletons into well-connected subsets along
 * edges (the greedy θ → 0 variant: the largest non-negative gain wins, ties to the lowest id). Returns the refined partition.
 */
function refine(g: WeightedGraph, comm: Int32Array, gamma: number): Int32Array {
  const { n, start, to, weight, strength, m2 } = g;
  const refined = new Int32Array(n), totalR = new Float64Array(n), external = new Float64Array(n), sizeR = new Int32Array(n), totalS = new Float64Array(n);
  for (let i = 0; i < n; i++) { refined[i] = i; totalR[i] = strength[i]!; sizeR[i] = 1; totalS[comm[i]!]! += strength[i]!; }
  for (let v = 0; v < n; v++) for (let e = start[v]!; e < start[v + 1]!; e++) if (comm[to[e]!] === comm[v]) external[v]! += weight[e]!;
  const neighbor = new Float64Array(n), seen = new Uint8Array(n), touched: number[] = [];
  for (let v = 0; v < n; v++) {
    if (sizeR[refined[v]!] !== 1) continue;
    const s = comm[v]!, kv = strength[v]!, ks = totalS[s]!, ext = external[refined[v]!]!;
    if (ext * m2 < gamma * kv * (ks - kv)) continue;
    for (let e = start[v]!; e < start[v + 1]!; e++) {
      const u = to[e]!;
      if (comm[u] !== s) continue;
      const c = refined[u]!;
      if (!seen[c]) { seen[c] = 1; touched.push(c); }
      neighbor[c]! += weight[e]!;
    }
    let best = -1, bestScore = 0;
    for (const c of touched) {
      if (c === refined[v]) continue;
      if (external[c]! * m2 < gamma * totalR[c]! * (ks - totalR[c]!)) continue;
      const score = neighbor[c]! * m2 - gamma * kv * totalR[c]!;
      if (score > bestScore || (score === bestScore && best !== -1 && c < best)) { best = c; bestScore = score; }
    }
    if (best >= 0 && bestScore > 0) {
      const from = refined[v]!;
      external[best] = external[best]! + ext - 2 * neighbor[best]!;
      totalR[best]! += kv; sizeR[best]!++; refined[v] = best;
      totalR[from] = 0; sizeR[from] = 0; external[from] = 0;
    }
    for (const c of touched) { neighbor[c] = 0; seen[c] = 0; }
    touched.length = 0;
  }
  return refined;
}
/** Aggregate on `refined` (nodes numbered by first member), with `comm` as the initial partition of the aggregate graph. */
function aggregate(g: WeightedGraph, refined: Int32Array, comm: Int32Array): { graph: WeightedGraph; nodeOf: Int32Array; comm: Int32Array } {
  const index = new Int32Array(g.n).fill(-1), nodeOf = new Int32Array(g.n);
  let count = 0;
  for (let i = 0; i < g.n; i++) { const r = refined[i]!; if (index[r] === -1) index[r] = count++; nodeOf[i] = index[r]!; }
  const self = new Float64Array(count), pairs = new Map<number, number>(), partition = new Int32Array(count);
  const dense = new Int32Array(g.n).fill(-1);
  let communities = 0;
  for (let i = 0; i < g.n; i++) {
    const a = nodeOf[i]!;
    if (dense[comm[i]!] === -1) dense[comm[i]!] = communities++;
    partition[a] = dense[comm[i]!]!;
    self[a]! += g.self[i]!;
    for (let e = g.start[i]!; e < g.start[i + 1]!; e++) {
      const j = g.to[e]!;
      if (j < i) continue;
      const b = nodeOf[j]!, w = g.weight[e]!;
      if (a === b) self[a]! += w;
      else { const key = Math.min(a, b) * count + Math.max(a, b); pairs.set(key, (pairs.get(key) ?? 0) + w); }
    }
  }
  return { graph: weightedGraph(count, pairs, self), nodeOf, comm: partition };
}
function modularity(g: WeightedGraph, comm: Int32Array, gamma: number): number {
  if (!g.m2) return 0;
  const inside = new Float64Array(g.n), total = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    total[comm[i]!]! += g.strength[i]!; inside[comm[i]!]! += 2 * g.self[i]!;
    for (let e = g.start[i]!; e < g.start[i + 1]!; e++) if (comm[g.to[e]!] === comm[i]) inside[comm[i]!]! += g.weight[e]!;
  }
  let q = 0;
  for (let c = 0; c < g.n; c++) if (total[c]) q += inside[c]! / g.m2 - gamma * (total[c]! / g.m2) ** 2;
  return q;
}
/** Split every community into its connected components (never lowers modularity), then renumber densely by first node. */
function connectedSplit(g: WeightedGraph, comm: Int32Array): Int32Array {
  const out = new Int32Array(g.n).fill(-1);
  let next = 0;
  const stack: number[] = [];
  for (let i = 0; i < g.n; i++) {
    if (out[i] !== -1) continue;
    out[i] = next; stack.push(i);
    while (stack.length) {
      const v = stack.pop()!;
      for (let e = g.start[v]!; e < g.start[v + 1]!; e++) { const u = g.to[e]!; if (out[u] === -1 && comm[u] === comm[i]) { out[u] = next; stack.push(u); } }
    }
    next++;
  }
  return out;
}
function leidenPass(base: WeightedGraph, initial: Int32Array, gamma: number): { comm: Int32Array; levels: number } {
  let g = base, comm: Int32Array = initial.slice(), map: Int32Array = new Int32Array(base.n).map((_, i) => i), levels = 0;
  for (; levels < MAX_LEVELS; levels++) {
    moveNodes(g, comm, gamma);
    let communities = 0;
    const used = new Uint8Array(g.n);
    for (let i = 0; i < g.n; i++) if (!used[comm[i]!]) { used[comm[i]!] = 1; communities++; }
    if (communities === g.n) { levels++; break; }
    const refined = refine(g, comm, gamma);
    const next = aggregate(g, refined, comm);
    if (next.graph.n === g.n) { levels++; break; } // no refinement merge: further levels cannot progress
    map = map.map(x => next.nodeOf[x]!);
    g = next.graph; comm = next.comm;
  }
  return { comm: connectedSplit(base, map.map(x => comm[x]!)), levels };
}
export interface LeidenResult { membership: Map<string, number>; modularity: number; levels: number; resolution: number }
/**
 * Deterministic Leiden for modularity over an undirected simple graph. Excluded ids get no community; every other id gets
 * one (an isolate is a singleton). Duplicate pairs count once and a self-loop has weight 1, as in a networkx Graph. Nodes are
 * indexed in code-point id order, so the result does not depend on input order. Communities are numbered by size
 * (descending), then by their smallest member id, and every community induces a connected subgraph.
 */
export function leidenCommunities(ids: readonly string[], edges: readonly (readonly [string, string])[], options: { exclude?: ReadonlySet<string>; resolution?: number } = {}): LeidenResult {
  const gamma = options.resolution ?? LEIDEN_RESOLUTION;
  const order = [...new Set(ids)].filter(id => !options.exclude?.has(id)).sort(compare), index = new Map(order.map((id, i) => [id, i]));
  const n = order.length, pairs = new Map<number, number>(), self = new Float64Array(n), selfSeen = new Uint8Array(n);
  for (const [source, target] of edges) {
    const a = index.get(source), b = index.get(target);
    if (a === undefined || b === undefined) continue;
    if (a === b) { if (!selfSeen[a]) { selfSeen[a] = 1; self[a] = 1; } continue; }
    pairs.set(Math.min(a, b) * n + Math.max(a, b), 1);
  }
  const g = weightedGraph(n, pairs, self);
  let comm: Int32Array = new Int32Array(n).map((_, i) => i), quality = modularity(g, comm, gamma), levels = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pass = leidenPass(g, comm, gamma), q = modularity(g, pass.comm, gamma);
    levels += pass.levels;
    if (round > 0 && !(q > quality)) break;
    comm = pass.comm; quality = q;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const members = groups.get(comm[i]!) ?? []; members.push(i); groups.set(comm[i]!, members); }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  const membership = new Map<string, number>();
  ranked.forEach((members, id) => { for (const i of members) membership.set(order[i]!, id); });
  return { membership, modularity: Math.round(quality * 1e6) / 1e6, levels, resolution: gamma };
}
/** Code-point string order, the tie-break every deterministic graph output uses. */
export const codePointCompare = compare;
/**
 * The same deterministic Leiden as `buildGraph`, over an arbitrary undirected graph whose nodes are all clustered (no hub
 * exclusion). Returns node id → community id (by size descending, then smallest member id).
 */
export function labelCommunities(ids: readonly string[], edges: readonly (readonly [string, string])[]): Map<string, number> {
  return leidenCommunities(ids, edges).membership;
}
/** Pure transformation of the derived-index snapshot, preserving the reference wiki graph semantics. */
export function buildGraph(snapshot: AnalysisSnapshot): VaultGraph {
  if (snapshot.notes.length > MAX_NODES) throw new Error(`graph: exceeds ${MAX_NODES} notes`);
  const sources = [...snapshot.notes].sort((a, b) => compare(a.path, b.path));
  const stems = new Set(sources.map(note => note.path.replace(/^notes\//, "").slice(0, -3)));
  const nodes: GraphNode[] = [], edges = new Map<string, GraphEdge>();
  for (const note of sources) {
    const id = note.path.replace(/^notes\//, "").slice(0, -3), { fm, body } = parse(note.source);
    const topics = truthy(fm.topics) ? fm.topics : [];
    nodes.push({ id, label: pythonTitle(id.replaceAll("-", " ")), type: pyString(truthy(fm.type) ? fm.type : "unknown"),
      domain: pyString(truthy(fm.domain) ? fm.domain : "unknown"), description: pyString(truthy(fm.description) ? fm.description : ""),
      confidence: pyString(truthy(fm.confidence) ? fm.confidence : ""), source_file: `notes/${id}.md`,
      topics: Array.isArray(topics) ? topics.map(topic => pyString(topic).replaceAll("[[", "").replaceAll("]]", "")).join(", ") : pyString(topics),
      community: null, degree: 0 });
    for (const match of body.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)) {
      const target = match[1]!.trim().toLowerCase().replaceAll(" ", "-");
      if (!stems.has(target)) continue;
      const [source, destination] = [id, target].sort(compare) as [string, string];
      edges.set(JSON.stringify([source, destination]), { source, target: destination, relation: "wiki_link", confidence_tag: "EXTRACTED", confidence: 1 });
      if (edges.size > MAX_EDGES) throw new Error(`graph: exceeds ${MAX_EDGES} edges`);
    }
  }
  const graph: VaultGraph = { directed: false, multigraph: false, graph: { partitioner: "leiden", resolution: LEIDEN_RESOLUTION, modularity: 0, iterations: 0, max_iterations: MAX_ITERATIONS }, nodes,
    edges: [...edges.values()].sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target)) };
  const neighbors = adjacency(graph);
  for (const node of nodes) node.degree = neighbors.get(node.id)!.size + Number(neighbors.get(node.id)!.has(node.id));
  communities(graph);
  return graph;
}
export function graphNeighbors(graph: VaultGraph, start: string, hops: 1 | 2, limit: number): GraphNeighborhood {
  if (hops !== 1 && hops !== 2) throw new Error("graph neighbors: hops must be 1 or 2");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("graph neighbors: limit must be 1..500");
  const neighbors = adjacency(graph);
  if (!neighbors.has(start)) throw new Error("graph neighbors: unknown note");
  const distances = new Map([[start, 0]]), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!, distance = distances.get(id)!;
    if (distance >= hops) continue;
    for (const neighbor of [...neighbors.get(id)!].sort(compare)) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1); queue.push(neighbor);
    }
  }
  const selected = new Set([...distances].sort(([a, ad], [b, bd]) => ad - bd || compare(a, b)).slice(0, limit).map(([id]) => id));
  return { start, hops, nodes: graph.nodes.filter(node => selected.has(node.id)), edges: graph.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)), truncated: distances.size > limit };
}
export function graphReport(graph: VaultGraph, today: string): string {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const rank = (a: GraphNode, b: GraphNode) => b.degree - a.degree || compare(a.id, b.id);
  const gods = graph.nodes.filter(node => !["moc", "bu", "file"].includes(node.type)).sort(rank).slice(0, 10);
  const groups = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) if (node.community !== null) { const members = groups.get(node.community) ?? []; members.push(node); groups.set(node.community, members); }
  const neighbors = adjacency(graph), seen = new Set<string>();
  let components = 0;
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    components++; const queue = [node.id]; seen.add(node.id);
    for (let i = 0; i < queue.length; i++) for (const neighbor of neighbors.get(queue[i]!)!) if (!seen.has(neighbor)) { seen.add(neighbor); queue.push(neighbor); }
  }
  const count = graph.nodes.length;
  const out = [`# Graph Report (${today})`, "", "## Overview", "", "- **Mode**: wiki", "- **Partitioner**: deterministic Leiden (modularity)", `- **Resolution**: ${graph.graph.resolution}`, `- **Modularity**: ${graph.graph.modularity.toFixed(4)}`,
    `- **Nodes**: ${count} (${graph.nodes.filter(node => HUB_TYPES.has(node.type)).length} hubs excluded from clustering)`, `- **Edges**: ${graph.edges.length}`,
    `- **Communities**: ${groups.size}`, `- **Isolates**: ${graph.nodes.filter(node => node.degree === 0).length}`, `- **Connected components**: ${components}`,
    `- **Density**: ${(count > 1 ? 2 * graph.edges.length / (count * (count - 1)) : 0).toFixed(4)}`, "", "## God Nodes (Top Connected)", "", "| Rank | Node | Degree |", "|------|------|--------|"];
  gods.forEach((node, index) => out.push(`| ${index + 1} | \`${node.id}\` | ${node.degree} |`));
  out.push("", "## Communities", "");
  for (const [id, members] of [...groups].sort(([a], [b]) => a - b)) {
    if (members.length === 1) continue;
    members.sort(rank); const membership = new Set(members.map(node => node.id));
    const types = new Map<string, number>();
    for (const member of members) types.set(member.type, (types.get(member.type) ?? 0) + 1);
    const mix = [...types].sort(([a, ac], [b, bc]) => bc - ac || compare(a, b));
    out.push(`### \`${members[0]!.id}\` cluster (${members.length} nodes, primary: ${mix[0]![0]})`, `- Build-local id: ${id} (not stable across builds, cite the anchor)`,
      `- Type mix: ${mix.map(([type, n]) => `${type}(${n})`).join(", ")}`, `- Internal edges: ${graph.edges.filter(edge => membership.has(edge.source) && membership.has(edge.target)).length}`,
      `- Sample: ${members.slice(0, 5).map(node => `\`${node.id}\``).join(", ")}`, "");
  }
  const cross = graph.edges.filter(edge => {
    const source = byId.get(edge.source)!, target = byId.get(edge.target)!;
    return source.community !== null && target.community !== null && source.community !== target.community;
  }).map(edge => ({ ...edge, score: byId.get(edge.source)!.degree + byId.get(edge.target)!.degree }))
    .sort((a, b) => b.score - a.score || compare(a.source, b.source) || compare(a.target, b.target));
  const used = new Map<string, number>(), selected = [];
  for (const edge of cross) {
    if ((used.get(edge.source) ?? 0) >= 2 || (used.get(edge.target) ?? 0) >= 2) continue;
    selected.push(edge); used.set(edge.source, (used.get(edge.source) ?? 0) + 1); used.set(edge.target, (used.get(edge.target) ?? 0) + 1);
    if (selected.length === 15) break;
  }
  out.push(`## Surprising Connections (Cross-Community): ${cross.length} total (top ${selected.length} shown)`, "");
  if (selected.length) { out.push("| Source | Target | Score |", "|--------|--------|-------|"); for (const edge of selected) out.push(`| \`${edge.source}\` | \`${edge.target}\` | ${edge.score} |`); }
  else out.push("No cross-community edges found.");
  return out.join("\n") + "\n";
}

/** Recompute derived degrees and communities after adding workspace nodes and edges. */
export function finalizeGraph(graph: VaultGraph): VaultGraph {
  const neighbors = adjacency(graph);
  for (const node of graph.nodes) node.degree = neighbors.get(node.id)!.size + Number(neighbors.get(node.id)!.has(node.id));
  communities(graph);
  return graph;
}
