import { describe, expect, test } from "bun:test";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { buildGraph, collectUnresolvedGraph } from "../src/vault-graph.ts";
import { assembleGraphSnapshot, encodeGraphPage, resolveGraphPage, graphEdgeColumns } from "../src/ui/graph-snapshot.ts";
import type { GraphNodeColumns, GraphEdgeColumns } from "../src/ui/panel-types.ts";
const input = (notes: AnalysisSnapshot["notes"]): AnalysisSnapshot => ({ notes, today: "2026-01-01", logPath: "log", log: null, registryIds: null, reports: {} });
const note = (id: string, source: string) => ({ path: `notes/${id}.md`, source });
describe("graph snapshot", () => {
  test("supersedes frontmatter adds directed snapshot edges without changing the legacy graph", () => {
    const s = input([
      note("a", '---\ntype: decision\nsupersedes: "[[b]]"\n---\n[[b]]'),
      note("b", '---\ntype: decision\nsupersedes: ["[[c]]", "[[missing#detail|label]]"]\n---\n'),
      note("c", '---\ntype: decision\nsuperseded_by: "[[notes/b.md]]"\n---\n'),
    ]);
    const graph = buildGraph(s), a = assembleGraphSnapshot(s, "v");
    expect(graph.edges).toHaveLength(1); expect(graph.edges[0]!.relation).toBe("wiki_link");
    const nodes = a.pages.find(p => p.kind === "nodes")!.columns as GraphNodeColumns;
    const rows = a.pages.filter(p => p.kind === "edges").flatMap(p => {
      const c = p.columns as GraphEdgeColumns;
      return c.source.map((source, i) => ({ source: nodes.id[source], target: nodes.id[c.target[i]!], relation: c.relations[c.relation[i]!], field: c.field[i], tag: Array.isArray(c.confidence_tag) ? c.confidence_tag[i] : c.confidence_tag }));
    });
    expect(rows).toEqual([
      { source: "a", target: "b", relation: "wiki_link", field: null, tag: "EXTRACTED" },
      { source: "a", target: "b", relation: "supersedes", field: "supersedes", tag: "EXTRACTED" },
      { source: "b", target: "c", relation: "supersedes", field: "supersedes", tag: "EXTRACTED" },
      { source: "c", target: "b", relation: "supersedes", field: "superseded_by", tag: "EXTRACTED" },
      { source: "b", target: "missing", relation: "supersedes", field: "supersedes", tag: "EXTRACTED" },
    ]);
    expect(a.pages[0]!.totals).toMatchObject({ nodes: 4, edges: 5, placeholders: 1 });
    expect(nodes.degree[nodes.id.indexOf("missing")]).toBe(1);
    for (const page of a.pages) expect(Buffer.byteLength(JSON.stringify(page)) + 32).toBeLessThanOrEqual(1_048_576);
  });
  test("unresolved links preserve resolved graph, metadata and pagination", () => {
    const s = input([note("a", "---\ncreated: 2024-01-01\nupdated: 2025-01-01\n---\n[[b]] [[missing]] [[missing]]"), note("b", "---\ndate: 2023-02-01\nupdated: [bad]\n---\n[[missing]]")]);
    const before = JSON.stringify(buildGraph(s));
    expect(collectUnresolvedGraph(s)).toHaveLength(2);
    const a = assembleGraphSnapshot(s, "vault");
    expect(JSON.stringify(buildGraph(s))).toBe(before);
    expect(a.pages[0]!.totals).toEqual({ nodes: 3, edges: 3, placeholders: 1, placeholdersOmitted: 0 });
    const n = a.pages[0]!.columns as GraphNodeColumns;
    expect(n.id).toEqual(["a", "b", "missing"]); expect(n.degree[2]).toBe(2);
    expect(n.updated).toEqual(["2025-01-01", null, null]); expect(n.date).toEqual(["2024-01-01", "2023-02-01", null]);
    expect(n.type[2]).toBeNull();
    for (const [i, p] of a.pages.entries()) {
      expect(Buffer.byteLength(JSON.stringify(p)) + 32).toBeLessThanOrEqual(1_048_576);
      if (i) expect(resolveGraphPage(a, encodeGraphPage(a, p))).toEqual(p);
      expect(p.next).toBe(i + 1 < a.pages.length ? encodeGraphPage(a, a.pages[i + 1]!) : null);
      if (p.kind === "edges") { const c = p.columns as GraphEdgeColumns; expect(c.source.every(v => v < 3)).toBe(true); expect(c.target.every(v => v < 3)).toBe(true); expect(c.confidence).toBe(1); }
    }
    expect(assembleGraphSnapshot(s, "vault").revision).toBe(a.revision);
    expect(assembleGraphSnapshot(input([note("a", "changed")]), "vault").revision).not.toBe(a.revision);
    for (const bad of ["bad", encodeGraphPage(assembleGraphSnapshot(s, "other"), a.pages[0]!), encodeGraphPage(assembleGraphSnapshot(input([]), "vault"), a.pages[0]!)]) expect(() => resolveGraphPage(a, bad)).toThrow("restart from the first page");
  });
  test("omits placeholders when node capacity is exhausted", () => {
    const s = input(Array.from({ length: 10_000 }, (_, i) => note(`n${String(i).padStart(5, "0")}`, i === 0 ? "[[missing]]" : "")));
    const a = assembleGraphSnapshot(s, "v"); expect(a.pages[0]!.totals.placeholdersOmitted).toBe(1);
  });
  test("anchors resolve against note stems and empty targets are ignored", () => {
    const s = input([note("a", "[[b#heading]] [[missing#section]] [[ |x]]"), note("b", "")]);
    const original = JSON.stringify(buildGraph(s));
    const a = assembleGraphSnapshot(s, "v");
    const columns = a.pages[0]!.columns as GraphNodeColumns;
    expect(columns.id).toEqual(["a", "b", "missing"]);
    expect(a.pages[0]!.totals.edges).toBe(1);
    expect(JSON.stringify(buildGraph(s))).toBe(original);
  });
  test("bare note paths and missing optional scalars", () => {
    const s = input([{ path: "bare.md", source: "---\ncreated: [invalid]\ndate: 2020-01-01\n---\n" }]);
    const columns = assembleGraphSnapshot(s, "v").pages[0]!.columns as GraphNodeColumns;
    expect(columns.id).toEqual(["bare"]);
    expect(columns.description).toEqual([null]); expect(columns.confidence).toEqual([null]); expect(columns.topics).toEqual([null]);
    expect(columns.type).toEqual(["unknown"]); expect(columns.domain).toEqual(["unknown"]);
    expect(columns.date).toEqual(["2020-01-01"]);
  });
  test("oversized node is refused", () => {
    const s = input([note("large", `---\ndescription: ${"x".repeat(1_100_000)}\n---\n`)]);
    expect(() => assembleGraphSnapshot(s, "v")).toThrow(/large.*shorten/);
  });
  test("node pages fill up to the actual next-token boundary", () => {
    const s = input(Array.from({ length: 3 }, (_, i) => note(`n${i}`, `---\ndescription: ${"x".repeat(400_000)}\n---\n`)));
    const a = assembleGraphSnapshot(s, "v"), first = a.pages[0]!, second = a.pages[1]!;
    expect(first.count).toBe(2); expect(second.count).toBe(1);
    const columns = Object.fromEntries(Object.entries(first.columns).map(([key, values]) => [key, [...values as unknown[], ...(second.columns as unknown as Record<string, unknown[]>)[key]!]]));
    expect(Buffer.byteLength(JSON.stringify({ ...first, count: 3, columns, next: null })) + 32).toBeGreaterThan(1_048_576);
  });
  test("mixed confidence tags stay aligned", () => {
    const s = input([note("a", "---\ninferred_links: [b]\n---\n- [[b]]\n- [[c]]\n"), note("b", ""), note("c", "")]);
    const page = assembleGraphSnapshot(s, "v").pages.find(p => p.kind === "edges")!;
    const c = page.columns as GraphEdgeColumns;
    expect(c.confidence_tag).toEqual(["INFERRED", "EXTRACTED"]);
    expect(c.confidence).toBe(1);
    const row = { source: 0, target: 1, relation: "wiki_link", field: null, rel: null, confidence_tag: "EXTRACTED", confidence: 1 };
    expect(graphEdgeColumns([row, { ...row, confidence: 0.5 }]).confidence).toEqual([1, 0.5]);
  });
  test("placeholder edges are sorted by source and target", () => {
    const result = assembleGraphSnapshot(input([note("a", "[[z-missing]]"), note("z", "[[a-missing]]")]), "v");
    const c = result.pages.find(p => p.kind === "edges")!.columns as GraphEdgeColumns;
    expect(c.source).toEqual([0, 1]); expect(c.target).toEqual([3, 2]);
  });
  test("maximum graph pages are bounded and contiguous", () => {
    const n = 10_000;
    const notes = Array.from({ length: n }, (_, i) => note(`n${String(i).padStart(5, "0")}`, Array.from({ length: 10 }, (_, j) => `[[n${String((i + j + 1) % n).padStart(5, "0")}]]`).join(" ")));
    const start = performance.now(), result = assembleGraphSnapshot(input(notes), "v"), elapsed = performance.now() - start;
    console.log(`maximum graph assembly and paging: ${elapsed.toFixed(1)} ms`);
    expect(result.pages[0]!.totals).toMatchObject({ nodes: n, edges: 100_000 });
    const offsets = { nodes: 0, edges: 0 };
    for (const p of result.pages) {
      expect(p.offset).toBe(offsets[p.kind]); offsets[p.kind] += p.count;
      expect(Buffer.byteLength(JSON.stringify(p)) + 32).toBeLessThanOrEqual(1_048_576);
      for (const [key, value] of Object.entries(p.columns)) if (Array.isArray(value) && key !== "relations") expect(value.length).toBe(p.count);
      if (p.kind === "edges") { const c = p.columns as GraphEdgeColumns; expect(c.source.every(v => v >= 0 && v < n)).toBe(true); expect(c.target.every(v => v >= 0 && v < n)).toBe(true); }
    }
    expect(offsets).toEqual({ nodes: n, edges: 100_000 });
  });
  test("resolved supersedes edges count toward the existing edge limit", () => {
    const n = 10_000;
    const notes = Array.from({ length: n }, (_, i) => note(`n${String(i).padStart(5, "0")}`, `${i === 0 ? '---\nsupersedes: "[[n00001]]"\n---\n' : ""}${Array.from({ length: 10 }, (_, j) => `[[n${String((i + j + 1) % n).padStart(5, "0")}]]`).join(" ")}`));
    expect(() => assembleGraphSnapshot(input(notes), "v")).toThrow("graph: exceeds 100000 edges");
    const m = 9_999;
    const fullEdges = Array.from({ length: m }, (_, i) => note(`n${String(i).padStart(5, "0")}`, `${i === 0 ? '---\nsupersedes: "[[missing]]"\n---\n' : ""}${Array.from({ length: i === 0 ? 20 : 10 }, (_, j) => `[[n${String((i + j + 1) % m).padStart(5, "0")}]]`).join(" ")}`));
    const graph = assembleGraphSnapshot(input(fullEdges), "v");
    expect(graph.pages[0]!.totals).toMatchObject({ edges: 100_000, placeholders: 0, placeholdersOmitted: 1 });
  });
});
