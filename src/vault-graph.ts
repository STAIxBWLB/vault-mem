import type { AnalysisSnapshot } from "./analysis-types.ts";
import { AnalysisYamlUnsupported, parseAnalysisYaml, scalarText, yamlTruthy } from "./analysis-yaml.ts";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  domain: string;
  description: string;
  confidence: string;
  source_file: string;
  topics: string;
  community: number | null;
  degree: number;
}
export interface GraphEdge { source: string; target: string; relation: "wiki_link"; confidence_tag: "EXTRACTED"; confidence: 1 }
export interface VaultGraph {
  directed: false;
  multigraph: false;
  graph: { partitioner: "label-propagation"; iterations: number; max_iterations: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphNeighborhood { start: string; hops: 1 | 2; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
const MAX_ITERATIONS = 32;
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
function pyString(value: unknown): string {
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
function communities(nodes: GraphNode[], neighbors: Map<string, Set<string>>): number {
  const labels = new Map(nodes.filter(node => !HUB_TYPES.has(node.type)).map(node => [node.id, node.id]));
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations++) {
    let changed = false;
    for (const [id, current] of labels) {
      const counts = new Map<string, number>();
      for (const neighbor of neighbors.get(id)!) {
        const label = labels.get(neighbor);
        if (label !== undefined) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const next = [...counts].sort(([a, ac], [b, bc]) => bc - ac || compare(a, b))[0]?.[0] ?? current;
      if (next !== current) { labels.set(id, next); changed = true; }
    }
    if (!changed) { iterations++; break; }
  }
  const groups = new Map<string, string[]>();
  for (const [id, label] of labels) { const group = groups.get(label) ?? []; group.push(id); groups.set(label, group); }
  const ids = new Map<string, number>();
  [...groups.values()].sort((a, b) => compare(a[0]!, b[0]!)).forEach((members, id) => { for (const member of members) ids.set(member, id); });
  for (const node of nodes) node.community = ids.get(node.id) ?? null;
  return iterations;
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
  const graph: VaultGraph = { directed: false, multigraph: false, graph: { partitioner: "label-propagation", iterations: 0, max_iterations: MAX_ITERATIONS }, nodes,
    edges: [...edges.values()].sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target)) };
  const neighbors = adjacency(graph);
  for (const node of nodes) node.degree = neighbors.get(node.id)!.size + Number(neighbors.get(node.id)!.has(node.id));
  graph.graph.iterations = communities(nodes, neighbors);
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
  const out = [`# Graph Report (${today})`, "", "## Overview", "", "- **Mode**: wiki", "- **Partitioner**: deterministic label-propagation (32 iterations maximum)",
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
