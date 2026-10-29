import { expect, test } from "bun:test";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { buildGraph, graphNeighbors, graphReport, pythonTitle } from "../src/vault-graph.ts";

function snapshot(notes: Record<string, string>): AnalysisSnapshot {
  return { notes: Object.entries(notes).map(([path, source]) => ({ path: `${path}.md`, source })),
    today: "2026-10-29", logPath: "/synthetic/log", log: null, registryIds: null, reports: {} };
}
const note = (body: string, type = "insight") => `---\ntype: ${type}\ndomain: research\ndescription: synthetic\ntopics: ["[[index]]"]\n---\n${body}`;

test("graph preserves reference body-only extraction, undirected deduplication and self loops", () => {
  const graph = buildGraph(snapshot({
    index: note("[[alpha]]", "moc"),
    alpha: note("[[BETA|shown]] [[beta]] [[alpha]] [[beta#heading]] [[not-found]]\n```md\n[[index]]\n```"),
    beta: note("[[alpha]]"),
  }));
  expect(graph.directed).toBe(false); expect(graph.multigraph).toBe(false);
  expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([["alpha", "alpha"], ["alpha", "beta"], ["alpha", "index"]]);
  expect(graph.nodes.find(node => node.id === "alpha")!.degree).toBe(4);
  expect(graph.nodes.find(node => node.id === "index")!.community).toBeNull();
  expect(graph.nodes[0]).toMatchObject({ id: "alpha", label: "Alpha", type: "insight", domain: "research", description: "synthetic", topics: "index", source_file: "notes/alpha.md" });
  expect(JSON.parse(JSON.stringify(graph)).edges[0]).toMatchObject({ relation: "wiki_link", confidence_tag: "EXTRACTED", confidence: 1 });
});

test("graph labels follow Python title boundaries and Unicode titlecase mappings", () => {
  for (const [value, expected] of [
    ["they're-BILL'S-123abc", "They'Re Bill'S 123Abc"],
    ["ßeta-ﬃle-ǳung", "Sseta Ffile ǲung"],
    ["éCLAIR-한글-ábc", "Éclair 한글 ÁBc"],
    ["ΟΣ-ΣΟΣ-ᾀ-ᾳ-ა", "Ος Σος ᾈ ᾼ ა"],
  ]) expect(pythonTitle(value!.replaceAll("-", " "))).toBe(expected!);
});

test("graph preserves legacy invalid-YAML fallback and Python field string values", () => {
  const graph = buildGraph(snapshot({
    broken: "---\ntype: method\ndomain: [invalid\ndescription: fallback\n---\n[[empty]]\n",
    empty: "plain [[broken]]",
    values: "---\ntype: false\ndomain: true\ndescription: [a, b]\ntopics: [false, null, '[[empty]]']\n---\n",
  }));
  expect(graph.nodes.find(node => node.id === "broken")).toMatchObject({ type: "method", domain: "[invalid", description: "fallback" });
  expect(graph.nodes.find(node => node.id === "empty")).toMatchObject({ type: "unknown", topics: "" });
  expect(graph.nodes.find(node => node.id === "values")).toMatchObject({ type: "unknown", domain: "True", description: "['a', 'b']", topics: "False, None, empty" });
  expect(graph.edges).toHaveLength(1);
});

test("community labels and report anchors are deterministic, with MOCs excluded from propagation", () => {
  const notes = {
    index: note("[[a]] [[d]] [[alone]]", "moc"),
    a: note("[[b]] [[c]]"), b: note("[[c]]"), c: note("[[f]]"),
    d: note("[[e]] [[f]]"), e: note("[[f]]"), f: note(""), alone: note(""),
  };
  const graph = buildGraph(snapshot(notes));
  expect(buildGraph(snapshot(Object.fromEntries(Object.entries(notes).reverse())))).toEqual(graph);
  const community = (id: string) => graph.nodes.find(node => node.id === id)!.community;
  expect(community("a")).toBe(community("b")); expect(community("a")).toBe(community("c"));
  expect(community("d")).toBe(community("e")); expect(community("d")).toBe(community("f"));
  expect(community("a")).not.toBe(community("d")); expect(community("alone")).not.toBe(community("a"));
  expect(graph.graph.iterations).toBeLessThanOrEqual(32);
  const report = graphReport(graph, "2026-10-29");
  for (const section of ["## Overview", "## God Nodes", "## Communities", "## Surprising Connections"]) expect(report).toContain(section);
  expect(report).toContain("### `a` cluster"); expect(report).toContain("### `d` cluster");
  expect(report).toContain("1 total (top 1 shown)");
});

test("bounded neighbors use one or two hops, reject invalid arguments and return induced edges", () => {
  const graph = buildGraph(snapshot({ a: note("[[b]] [[c]]"), b: note("[[d]]"), c: note(""), d: note("[[e]]"), e: note("") }));
  expect(graphNeighbors(graph, "a", 1, 500).nodes.map(node => node.id)).toEqual(["a", "b", "c"]);
  expect(graphNeighbors(graph, "a", 2, 500).nodes.map(node => node.id)).toEqual(["a", "b", "c", "d"]);
  const limited = graphNeighbors(graph, "a", 2, 2);
  expect(limited.nodes.map(node => node.id)).toEqual(["a", "b"]); expect(limited.truncated).toBe(true);
  expect(limited.edges.map(edge => [edge.source, edge.target])).toEqual([["a", "b"]]);
  for (const limit of [0, 501, 1.5, NaN]) expect(() => graphNeighbors(graph, "a", 1, limit)).toThrow("limit");
  expect(() => graphNeighbors(graph, "a", 3 as 1, 1)).toThrow("hops");
  expect(() => graphNeighbors(graph, "missing", 1, 1)).toThrow("unknown");
});
