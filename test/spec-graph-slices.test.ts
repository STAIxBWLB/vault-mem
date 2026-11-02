import { expect, test } from "bun:test";
import { buildSpecGraph, specSlice, SPEC_EDGE_KINDS, MAX_SPEC_INPUTS, MAX_SPEC_EDGES } from "../src/spec-graph.ts";
import type { SpecDocument, SpecSnapshot } from "../src/spec-source.ts";

function document(id: string, frontmatter: Record<string, unknown> = {}, body = "", path = `${id}/SPEC.md`): SpecDocument {
  return { id, path, hash: "synthetic-hash", source: "Synthetic private source omitted from graph results.", frontmatter: { id, type: "module", title: `Synthetic ${id}`, ...frontmatter }, body };
}
function snapshot(specs: SpecDocument[]): SpecSnapshot { return { root: "/synthetic/repository", commonDir: "/synthetic/repository/.git", specs, diagnostics: [] }; }
const ids = (nodes: { id: string }[]) => nodes.map(node => node.id);

function fixture() {
  return buildSpecGraph(snapshot([
    document("goal", { type: "goal", status: "active" }, "", "design.md"),
    document("architecture", { type: "architecture", parent: "[[goal]]" }),
    document("module", { parent: "architecture", "depends-on": ["support", "[[support]]"], references: ["[[goal]]"], implements: ["goal"], "superseded-by": "[[replacement]]", status: "deprecated" }, "[[goal]] [[support#Detail|Label]] [[missing-body]]\n```md\n[[hidden]]\n```\n`[[inline-hidden]]`", "packages/a/SPEC.md"),
    document("leaf", { type: "future-type", parent: "module", status: "future-status" }),
    document("support", { parent: "goal" }),
    document("replacement", { parent: "goal", references: ["[[module]]", "[[missing-reference]]"] }),
    document("unrelated", { references: ["[[packages/a/SPEC.md]]"] }),
  ]));
}

test("spec graph resolves every relation by exact id, retains unknown read vocabulary and hides raw sources", () => {
  const graph = fixture();
  expect(ids(graph.nodes)).toEqual(["architecture", "goal", "leaf", "module", "replacement", "support", "unrelated"]);
  expect(graph.nodes.find(node => node.id === "leaf")).toMatchObject({ type: "future-type", status: "future-status" });
  expect(graph.edges.filter(edge => edge.source === "module")).toEqual([
    { source: "module", target: "architecture", kind: "parent" },
    { source: "module", target: "support", kind: "depends-on" },
    { source: "module", target: "goal", kind: "references" },
    { source: "module", target: "goal", kind: "implements" },
    { source: "module", target: "replacement", kind: "superseded-by" },
    { source: "module", target: "goal", kind: "body_link" },
    { source: "module", target: "support", kind: "body_link" },
  ]);
  expect(new Set(graph.edges.map(edge => edge.kind))).toEqual(new Set(SPEC_EDGE_KINDS));
  expect(graph.unresolved).toEqual([
    { source: "module", target: "missing-body", kind: "body_link" },
    { source: "replacement", target: "missing-reference", kind: "references" },
    { source: "unrelated", target: "packages/a/SPEC.md", kind: "references" },
  ]);
  expect(JSON.stringify(graph)).not.toContain("hidden");
  expect(JSON.stringify(graph)).not.toContain("Synthetic private source");
  for (const node of graph.nodes) { expect(node).not.toHaveProperty("source"); expect(node).not.toHaveProperty("body"); expect(node).not.toHaveProperty("frontmatter"); }
});

test("spec graph is stable under input order, keeps case-sensitive ids and reports first NFC-path duplicate", () => {
  const first = document("same", { type: "goal" }, "", "a/SPEC.md"), second = document("same", {}, "[[Same]]", "z/SPEC.md"), distinct = document("Same");
  const input = snapshot([second, distinct, first]);
  const a = buildSpecGraph(input), b = buildSpecGraph(snapshot([...input.specs].reverse()));
  expect(a).toEqual(b);
  expect(ids(a.nodes)).toEqual(["Same", "same"]);
  expect(a.nodes.find(node => node.id === "same")?.path).toBe("a/SPEC.md");
  expect(a.diagnostics).toEqual([expect.objectContaining({ code: "duplicate_id", path: "z/SPEC.md", id: "same", firstPath: "a/SPEC.md" })]);
  expect(input.specs[0]).toBe(second);
});

test("subtree and ancestor slices use parent direction and flag depth truncation", () => {
  const graph = fixture();
  expect(ids(specSlice(graph, "goal").nodes)).toEqual(["architecture", "goal", "replacement", "support"]);
  expect(specSlice(graph, "goal").truncated).toBe(true);
  const all = specSlice(graph, "goal", { depth: 3 });
  expect(ids(all.nodes)).toEqual(["architecture", "goal", "leaf", "module", "replacement", "support"]);
  expect(all.truncated).toBe(false);
  expect(all.edges.every(edge => edge.kind === "parent")).toBe(true);
  expect(ids(specSlice(graph, "leaf", { direction: "ancestors", depth: 3 }).nodes)).toEqual(["architecture", "goal", "leaf", "module"]);
  expect(specSlice(graph, "leaf", { direction: "ancestors", depth: 3 }).truncated).toBe(false);
  expect(specSlice(graph, "goal", { direction: "ancestors" })).toEqual({ nodes: [graph.nodes.find(node => node.id === "goal")!], edges: [], truncated: false });
});

test("neighbor slices traverse both ways, filter edge kind and use deterministic node limits", () => {
  const graph = fixture();
  expect(ids(specSlice(graph, "module", { direction: "neighbors", depth: 1 }).nodes)).toEqual(["architecture", "goal", "leaf", "module", "replacement", "support"]);
  expect(ids(specSlice(graph, "support", { direction: "neighbors", edge: "depends-on" }).nodes)).toEqual(["module", "support"]);
  expect(specSlice(graph, "support", { direction: "neighbors", edge: "depends-on" }).truncated).toBe(false);
  const limited = specSlice(graph, "goal", { depth: 3, limit: 2 });
  expect(ids(limited.nodes)).toEqual(["architecture", "goal"]);
  expect(limited.truncated).toBe(true);
  expect(specSlice(graph, "goal", { depth: 0 })).toMatchObject({ nodes: [expect.objectContaining({ id: "goal" })], edges: [], truncated: true });
});

test("cycles and self links terminate, and slice bounds have actionable refusals", () => {
  const graph = buildSpecGraph(snapshot([document("a", { parent: "b" }, "[[a]]"), document("b", { parent: "a" })]));
  expect(ids(specSlice(graph, "a", { depth: 3 }).nodes)).toEqual(["a", "b"]);
  expect(specSlice(graph, "a", { depth: 3 }).truncated).toBe(false);
  expect(specSlice(graph, "a", { direction: "neighbors", edge: "body_link" })).toMatchObject({ nodes: [expect.objectContaining({ id: "a" })], truncated: false });
  for (const depth of [-1, 4, 1.5, NaN, Infinity]) expect(() => specSlice(graph, "a", { depth })).toThrow("pass a smaller depth");
  for (const limit of [0, 501, 1.5, NaN, Infinity]) expect(() => specSlice(graph, "a", { limit })).toThrow("pass a valid node limit");
  expect(() => specSlice(graph, "unknown")).toThrow("select an id");
  expect(() => specSlice(graph, "a", { direction: "wrong" as "subtree" })).toThrow("choose subtree");
  expect(() => specSlice(graph, "a", { edge: "wrong" as "parent" })).toThrow("choose a kind");
});

test("graph construction refuses excess input specs and counts unique unresolved edges toward its bound", () => {
  expect(() => buildSpecGraph(snapshot(Array.from({ length: MAX_SPEC_INPUTS + 1 }, (_, index) => document(`spec-${index}`))))).toThrow("pass a smaller SpecSnapshot");
  const body = Array.from({ length: MAX_SPEC_EDGES + 1 }, (_, index) => `[[n${index}]]`).join("\n");
  expect(Buffer.byteLength(body)).toBeLessThan(2 * 1024 * 1024);
  expect(() => buildSpecGraph(snapshot([document("source", {}, body)]))).toThrow("reduce link lists");
});

test("slice truncation is based on the final selected set, not cross edges inside the frontier", () => {
  const graph = buildSpecGraph(snapshot([
    document("root", { references: ["a", "b"] }),
    document("a", { references: ["b"] }),
    document("b", { references: ["a"] }),
  ]));
  const slice = specSlice(graph, "root", { direction: "neighbors", edge: "references", depth: 1, limit: 3 });
  expect(ids(slice.nodes)).toEqual(["a", "b", "root"]);
  expect(slice.truncated).toBe(false);
  expect(slice.edges).toHaveLength(4);
});

test("long ids stay intact while repeated links deduplicate separately by source, kind and target", () => {
  const id = "source-" + "x".repeat(8192);
  const targets = Array.from({ length: 128 }, (_, index) => document(`target-${index}`));
  const refs = targets.map(target => target.id);
  const source = document(id, { references: [...refs, ...refs] }, refs.map(target => `[[${target}]] [[${target}]]`).join("\n"), "source.md");
  const graph = buildSpecGraph(snapshot([source, ...targets]));
  expect(graph.nodes.some(node => node.id === id)).toBe(true);
  expect(graph.edges).toHaveLength(refs.length * 2);
  expect(graph.edges.every(edge => edge.source === id)).toBe(true);
  expect(graph.edges.filter(edge => edge.kind === "references")).toHaveLength(refs.length);
  expect(graph.edges.filter(edge => edge.kind === "body_link")).toHaveLength(refs.length);
  expect(graph.unresolved).toEqual([]);
});
