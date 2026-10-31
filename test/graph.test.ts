import { expect, test } from "bun:test";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { buildGraph, graphNeighbors, graphReport, leidenCommunities, pythonTitle } from "../src/vault-graph.ts";

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
  expect(graph.graph.iterations).toBeLessThanOrEqual(graph.graph.max_iterations);
  expect(graph.graph).toMatchObject({ partitioner: "leiden", resolution: 1 });
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

// ── Leiden: planted partitions, connectivity, determinism ──────────────
type Edge = readonly [string, string];
/** mulberry32: a small seeded generator so fixtures are identical on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n: number) => String(n).padStart(3, "0");
function clique(prefix: string, k: number): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) out.push([`${prefix}${pad(i)}`, `${prefix}${pad(j)}`]);
  return out;
}
/** Normalized mutual information (arithmetic mean normalization, as sklearn's default). */
function nmi(a: Map<string, number>, b: Map<string, number>): number {
  const ids = [...a.keys()], n = ids.length, joint = new Map<string, number>(), ca = new Map<number, number>(), cb = new Map<number, number>();
  for (const id of ids) {
    const x = a.get(id)!, y = b.get(id)!;
    joint.set(`${x},${y}`, (joint.get(`${x},${y}`) ?? 0) + 1); ca.set(x, (ca.get(x) ?? 0) + 1); cb.set(y, (cb.get(y) ?? 0) + 1);
  }
  const h = (c: Map<number, number>) => -[...c.values()].reduce((s, v) => s + (v / n) * Math.log(v / n), 0);
  let mi = 0;
  for (const [key, v] of joint) { const [x, y] = key.split(",").map(Number) as [number, number]; mi += (v / n) * Math.log((v * n) / (ca.get(x)! * cb.get(y)!)); }
  const ha = h(ca), hb = h(cb);
  return ha + hb === 0 ? 1 : (2 * mi) / (ha + hb);
}
/** Planted partition with `blocks` groups of `size`, average degree `degree` and mixing μ (expected share of outside edges). */
function sbm(blocks: number, size: number, degree: number, mu: number, seed: number): { ids: string[]; edges: Edge[]; truth: Map<string, number> } {
  const random = rng(seed), n = blocks * size, ids: string[] = [], truth = new Map<string, number>(), edges: Edge[] = [];
  for (let i = 0; i < n; i++) { const id = `n${String(i).padStart(4, "0")}`; ids.push(id); truth.set(id, Math.floor(i / size)); }
  const pIn = (degree * (1 - mu)) / (size - 1), pOut = (degree * mu) / (n - size);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (random() < (truth.get(ids[i]!) === truth.get(ids[j]!) ? pIn : pOut)) edges.push([ids[i]!, ids[j]!]);
  return { ids, edges, truth };
}
function connected(membership: Map<string, number>, edges: readonly Edge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) { adj.set(a, [...(adj.get(a) ?? []), b]); adj.set(b, [...(adj.get(b) ?? []), a]); }
  const groups = new Map<number, string[]>();
  for (const [id, c] of membership) groups.set(c, [...(groups.get(c) ?? []), id]);
  for (const members of groups.values()) {
    const inside = new Set(members), seen = new Set([members[0]!]), stack = [members[0]!];
    while (stack.length) for (const u of adj.get(stack.pop()!) ?? []) if (inside.has(u) && !seen.has(u)) { seen.add(u); stack.push(u); }
    if (seen.size !== members.length) return false;
  }
  return true;
}
const groupsOf = (membership: Map<string, number>) => {
  const groups = new Map<number, string[]>();
  for (const [id, c] of membership) groups.set(c, [...(groups.get(c) ?? []), id]);
  return [...groups.values()].map(g => g.sort());
};

test("Leiden splits two cliques joined by one edge", () => {
  const edges = [...clique("a", 6), ...clique("b", 6), ["a000", "b000"] as const];
  const result = leidenCommunities([...new Set(edges.flat())], edges);
  expect(groupsOf(result.membership).sort((x, y) => x[0]!.localeCompare(y[0]!))).toEqual([
    Array.from({ length: 6 }, (_, i) => `a${pad(i)}`), Array.from({ length: 6 }, (_, i) => `b${pad(i)}`),
  ]);
  // m = 31 (two K6 plus the bridge): Q = 2 * (30/62 - (31/62)^2).
  expect(result.modularity).toBeCloseTo(2 * (30 / 62 - (31 / 62) ** 2), 5);
});

test("Leiden recovers every clique of a ring below the resolution limit", () => {
  const edges: Edge[] = [];
  for (let c = 0; c < 10; c++) { edges.push(...clique(`c${pad(c)}_`, 6)); edges.push([`c${pad(c)}_000`, `c${pad((c + 1) % 10)}_005`]); }
  const result = leidenCommunities([...new Set(edges.flat())], edges);
  const groups = groupsOf(result.membership);
  expect(groups).toHaveLength(10);
  for (const group of groups) expect(new Set(group.map(id => id.slice(0, 4))).size).toBe(1);
  expect(connected(result.membership, edges)).toBe(true);
});

test("Leiden reaches NMI >= 0.9 on planted partitions with mixing 0.1, 0.2 and 0.3", () => {
  for (const [mu, seed] of [[0.1, 11], [0.2, 12], [0.3, 13]] as const) {
    const { ids, edges, truth } = sbm(8, 40, 12, mu, seed);
    const result = leidenCommunities(ids, edges);
    expect(nmi(result.membership, truth)).toBeGreaterThanOrEqual(0.9);
    expect(connected(result.membership, edges)).toBe(true);
  }
});

test("Leiden output is independent of node and edge input order and repeatable", () => {
  const { ids, edges } = sbm(6, 30, 10, 0.25, 7);
  const base = leidenCommunities(ids, edges);
  const random = rng(99), shuffle = <T>(xs: T[]) => { const out = [...xs]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; } return out; };
  for (let i = 0; i < 3; i++) {
    const flipped = shuffle(edges).map(([a, b]) => (random() < 0.5 ? [b, a] as const : [a, b] as const));
    const again = leidenCommunities(shuffle(ids), flipped);
    expect([...again.membership].sort()).toEqual([...base.membership].sort());
    expect(again.modularity).toBe(base.modularity);
  }
  expect(leidenCommunities(ids, edges)).toEqual(base);
});

test("Leiden numbers communities by size then smallest id, keeps isolates singleton and honors exclusion", () => {
  const edges: Edge[] = [...clique("s", 3), ...clique("t", 5), ["hub", "s000"], ["hub", "t000"]];
  const result = leidenCommunities(["iso", "hub", ...new Set(edges.flat())], edges, { exclude: new Set(["hub"]) });
  expect(result.membership.has("hub")).toBe(false);
  expect(result.membership.get("t000")).toBe(0);
  expect(result.membership.get("s000")).toBe(1);
  expect(result.membership.get("iso")).toBe(2);
  expect(leidenCommunities([], []).membership.size).toBe(0);
  expect(leidenCommunities(["only"], []).membership.get("only")).toBe(0);
});

test("vault graph JSON is byte-identical across builds and records Leiden metadata", () => {
  const notes: Record<string, string> = { index: note("", "moc") };
  for (let c = 0; c < 4; c++) for (let i = 0; i < 5; i++) {
    const links = [0, 1, 2, 3, 4].filter(j => j !== i).map(j => `[[g${c}-n${j}]]`).join(" ") + (i === 0 ? ` [[g${(c + 1) % 4}-n1]]` : "");
    notes[`g${c}-n${i}`] = note(links);
  }
  const first = JSON.stringify(buildGraph(snapshot(notes))), second = JSON.stringify(buildGraph(snapshot(Object.fromEntries(Object.entries(notes).reverse()))));
  expect(second).toBe(first);
  const graph = JSON.parse(first);
  expect(graph.graph).toMatchObject({ partitioner: "leiden", resolution: 1 });
  expect(graph.graph.modularity).toBeGreaterThan(0.5);
  expect(new Set(graph.nodes.filter((n: { id: string }) => n.id !== "index").map((n: { community: number }) => n.community)).size).toBe(4);
  const report = graphReport(buildGraph(snapshot(notes)), "2026-10-31");
  expect(report).toContain("- **Partitioner**: deterministic Leiden (modularity)");
  expect(report).toContain(`- **Modularity**: ${graph.graph.modularity.toFixed(4)}`);
});
