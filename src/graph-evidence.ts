import { createHash } from "node:crypto";
import type { AnalysisSnapshot } from "./analysis-types.ts";
import { authoredLinkOffsets, noteKey } from "./links.ts";
import { buildGraph, codePointCompare, graphBody, graphPath, legacyTarget, linkRelation, LEGACY_LINK, type GraphEdge, type GraphPathOptions } from "./vault-graph.ts";

/** Occurrences kept per hop, and the bound on the complete encoded result (envelope and escaping included). */
export const EXPLAIN_OCCURRENCES_PER_HOP = 20, EXPLAIN_MAX_BYTES = 48 * 1024;
const MAX_TEXT_BYTES = 512;
/** Identifies the path selection the snapshot hash covers; bump it if graphPath's selection ever changes. */
const ALGORITHM = "graph-path-bfs-codepoint-v1";

export interface GraphOccurrence {
  /**
   * `legacy_graph_match`: the body match `buildGraph` turned into this hop's edge. `annotation`: a heading/block-anchored
   * or frontmatter reference between the same notes; it explains context but never adds a traversable edge.
   */
  kind: "legacy_graph_match" | "annotation";
  /** True when `extractLinks` also accepts it as an authored link (visible, not escaped, not in code). */
  authored: boolean;
  origin: { path: string; sha256: string };
  /** One-based line in the whole note file, and the zero-based UTF-8 byte range of the link text in the file. */
  line: number;
  bytes: { start: number; end: number };
  /** `body` or `frontmatter`, with the frontmatter key in `field`. */
  source: "body" | "frontmatter";
  field?: string;
  /** The declared `(relation)` of a typed list link, else `wiki_link`. */
  relation: string;
  /** As written: the note that contains the link, and the note it names. */
  authoredFrom: string;
  authoredTo: string;
  /** `forward` when the path walks from the authoring note to the named note; `reverse` when it walks against the link. */
  traversal: "forward" | "reverse";
  anchor?: { heading?: string; block?: string };
  embed?: true;
  /** The literal link text, at most 512 bytes. */
  text: string;
}
export interface GraphHop {
  index: number;
  from: string;
  to: string;
  /** The deduplicated graph edge this hop used: structural metadata only, never a quote or a probability. */
  edge: { kind: "structural"; relation: GraphEdge["relation"]; rel?: string; field: "body"; confidence_tag?: "INFERRED" };
  occurrences: GraphOccurrence[];
  /** Occurrences found for this pair that the per-hop or byte bound left out. */
  omitted: number;
}
export interface GraphExplanation {
  schemaVersion: 1;
  /** sha256 over sorted note paths with their content hashes and the path options: a content identity, not a signature. */
  snapshotHash: string;
  path: { from: string; to: string; found: boolean; length: number; nodes: string[]; options: { maxHops: number; relation: string | null; viaHubs: boolean } };
  hops: GraphHop[];
  structuralOnly: true;
  truncated: boolean;
  limits: { occurrencesPerHop: number; maxBytes: number };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => Buffer.byteLength(text);
const stemOf = (path: string) => path.replace(/^notes\//, "").slice(0, -3);
function bounded(text: string): string {
  if (bytes(text) <= MAX_TEXT_BYTES) return text;
  let out = "";
  for (const character of text) { if (bytes(out + character) > MAX_TEXT_BYTES - 3) break; out += character; }
  return out + "...";
}

/** A match found by the cheap pass: its position and fields, before any line or byte location is computed. */
interface Candidate { self: string; other: string; at: number; length: number; fields: Omit<GraphOccurrence, "origin" | "authoredFrom" | "authoredTo" | "traversal" | "line" | "bytes"> }
/** True when an annotation address names `other`: by the navigation note key (`b.md`, `notes/b`) or the legacy stem rule. */
const names = (address: string, other: string) => noteKey(address) === noteKey(other) || legacyTarget(address) === other;
/**
 * Every body match and annotation between `a` and `b` in the notes `a` and `b`, sorted (forward author first, then
 * note, then file position). Only positions are collected here; locations are computed later for the kept ones.
 */
function candidates(notes: Map<string, { source: string; sha256: string }>, a: string, b: string, from: string): Candidate[] {
  const out: Candidate[] = [];
  for (const [self, other] of [[a, b], [b, a]] as const) {
    const note = notes.get(self);
    if (!note) continue;
    const { body, offset } = graphBody(note.source), authored = authoredLinkOffsets(body), legacy = new Set<number>();
    for (const match of body.matchAll(LEGACY_LINK)) {
      if (legacyTarget(match[1]!) !== other) continue;
      legacy.add(match.index);
      const link = authored.get(match.index), rel = linkRelation(body, match.index, match[0].length);
      out.push({ self, other, at: offset + match.index, length: match[0].length,
        fields: { kind: "legacy_graph_match", authored: link !== undefined, source: "body", relation: rel ?? "wiki_link", ...(link?.embed ? { embed: true } : {}), text: bounded(match[0]) } });
    }
    // Authored anchored links never become legacy edges ("x#h" is not a stem), so they annotate only.
    for (const [index, link] of authored) {
      if (legacy.has(index) || (!link.heading && !link.block) || !names(link.target, other)) continue;
      const end = body.indexOf("]]", index) + 2;
      out.push({ self, other, at: offset + index, length: end - index, fields: { kind: "annotation", authored: true, source: "body", relation: linkRelation(body, index, end - index) ?? "wiki_link",
        anchor: { ...(link.heading ? { heading: link.heading } : {}), ...(link.block ? { block: link.block } : {}) }, ...(link.embed ? { embed: true } : {}), text: bounded(body.slice(index, end)) } });
    }
    // Frontmatter references annotate the pair; the legacy graph never makes edges from them.
    let field: string | undefined, lineStart = 0;
    for (const line of note.source.slice(0, offset).split("\n")) {
      const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
      if (key) field = key[1];
      for (const match of line.matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)) if (field && names(match[1]!.trim(), other))
        out.push({ self, other, at: lineStart + match.index, length: match[0].length, fields: { kind: "annotation", authored: false, source: "frontmatter", field, relation: "wiki_link", text: bounded(match[0]) } });
      lineStart += line.length + 1;
    }
  }
  const rank = (c: Candidate) => c.self === from ? 0 : 1;
  return out.sort((x, y) => rank(x) - rank(y) || codePointCompare(x.self, y.self) || x.at - y.at);
}
/** Locations for the kept candidates only: one forward walk per note over the sorted positions, so the cost is linear. */
function locate(notes: Map<string, { source: string; sha256: string }>, kept: Candidate[], from: string): GraphOccurrence[] {
  const located = new Map<Candidate, { line: number; start: number; end: number }>();
  for (const self of new Set(kept.map(c => c.self))) {
    const source = notes.get(self)!.source, mine = kept.filter(c => c.self === self).sort((x, y) => x.at - y.at);
    let at = 0, line = 1, byte = 0;
    for (const c of mine) {
      for (let i = source.indexOf("\n", at); i !== -1 && i < c.at; i = source.indexOf("\n", i + 1)) line++;
      byte += bytes(source.slice(at, c.at)); at = c.at;
      located.set(c, { line, start: byte, end: byte + bytes(source.slice(c.at, c.at + c.length)) });
    }
  }
  return kept.map(c => {
    const where = located.get(c)!, note = notes.get(c.self)!;
    return { ...c.fields, origin: { path: `notes/${c.self}.md`, sha256: note.sha256 }, line: where.line, bytes: { start: where.start, end: where.end },
      authoredFrom: c.self, authoredTo: c.other, traversal: c.self === from ? "forward" : "reverse" } as GraphOccurrence;
  });
}
/**
 * Bytes of the largest encoding a caller receives: the MCP JSON-RPC response wrapping the result as text content (a
 * superset of the CLI `--json` line), with room for a request id of up to ENVELOPE_ID_BYTES.
 */
const ENVELOPE_ID_BYTES = 128;
export function encodedBytes(result: GraphExplanation): number {
  return bytes(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(ENVELOPE_ID_BYTES), result: { content: [{ type: "text", text: JSON.stringify(result) }] } })) + 1;
}

/**
 * Explain `graphPath`'s selected path from the same snapshot: the path is chosen by `graphPath` itself, then each hop
 * lists the source occurrences behind its edge. Pure and deterministic: the same snapshot and options give
 * byte-identical JSON. Reads nothing beyond the snapshot and writes nothing.
 */
export function explainGraphPath(snapshot: AnalysisSnapshot, from: string, to: string, options: GraphPathOptions = {}): GraphExplanation {
  const maxHops = options.maxHops ?? 6, relation = options.relation ?? null, viaHubs = options.viaHubs === true;
  const graph = buildGraph(snapshot), path = graphPath(graph, from, to, options);
  // Snapshot paths are relative to notes/ ("stem.md"), as buildGraph reads them.
  const notes = new Map(snapshot.notes.map(note => [stemOf(note.path), { source: note.source, sha256: sha(note.source) }]));
  const identity = [...notes].sort(([a], [b]) => codePointCompare(a, b)).map(([stem, note]) => [stem, note.sha256]);
  const snapshotHash = sha(JSON.stringify({ algorithm: ALGORITHM, notes: identity, options: { maxHops, relation, viaHubs } }));
  const hops: GraphHop[] = path.edges.map((edge, index) => {
    const found = candidates(notes, edge.source, edge.target, edge.source);
    return { index, from: edge.source, to: edge.target, edge: { kind: "structural", relation: edge.relation, ...(edge.rel ? { rel: edge.rel } : {}), field: "body", ...(edge.confidence_tag === "INFERRED" ? { confidence_tag: "INFERRED" as const } : {}) },
      occurrences: locate(notes, found.slice(0, EXPLAIN_OCCURRENCES_PER_HOP), edge.source), omitted: Math.max(0, found.length - EXPLAIN_OCCURRENCES_PER_HOP) };
  });
  const result: GraphExplanation = { schemaVersion: 1, snapshotHash,
    path: { from: path.from, to: path.to, found: path.found, length: path.length, nodes: path.nodes.map(node => node.id), options: { maxHops, relation, viaHubs } },
    hops, structuralOnly: true, truncated: hops.some(hop => hop.omitted > 0), limits: { occurrencesPerHop: EXPLAIN_OCCURRENCES_PER_HOP, maxBytes: EXPLAIN_MAX_BYTES } };
  // Byte bound on the complete encoded output (envelope and escaping): drop occurrences from the last hop backwards
  // until it fits; every drop is counted. Setting `truncated` first keeps the measured size an upper bound.
  if (encodedBytes(result) > EXPLAIN_MAX_BYTES) {
    result.truncated = true;
    for (let i = hops.length - 1; i >= 0 && encodedBytes(result) > EXPLAIN_MAX_BYTES; i--) {
      const hop = hops[i]!;
      while (hop.occurrences.length && encodedBytes(result) > EXPLAIN_MAX_BYTES) { hop.occurrences.pop(); hop.omitted++; }
    }
    if (encodedBytes(result) > EXPLAIN_MAX_BYTES) throw Object.assign(new Error(`graph explain: path metadata alone exceeds ${EXPLAIN_MAX_BYTES} bytes; lower --max-hops`), { code: "V09" });
  }
  return result;
}
