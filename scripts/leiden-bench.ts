/** Clustering time on the release benchmark's 5,000-note synthetic graph (the same note and link shape): `bun scripts/leiden-bench.ts`. */
import { buildGraph } from "../src/vault-graph.ts";
const notes = [{ path: "research.md", source: "---\ntype: moc\ndescription: Synthetic benchmark navigation.\n---\n# Research\n" }];
for (let i = 0; i < 4999; i++) {
  const id = String(i).padStart(4, "0"), next = String((i + 1) % 4999).padStart(4, "0");
  notes.push({ path: `finding-${id}.md`, source: `---\ntitle: Synthetic Finding ${id}\ntype: insight\ndomain: research\ndescription: Synthetic benchmark observation ${id}.\ntopics: ["[[research]]"]\n---\n# Synthetic Finding ${id}\n\nSynthetic marker${id} evidence. Revision 0.\n\n## Connections\n\n- [[finding-${next}]]\n\n## Topics\n\n- [[research]]\n` });
}
const snapshot = { notes, today: "2026-10-31", logPath: "/synthetic/log", log: null, registryIds: null, reports: {} };
buildGraph(snapshot); // warm-up
const runs: number[] = [];
let graph = buildGraph(snapshot);
for (let i = 0; i < 5; i++) { const t = performance.now(); graph = buildGraph(snapshot); runs.push(performance.now() - t); }
runs.sort((a, b) => a - b);
console.log(JSON.stringify({ notes: graph.nodes.length, edges: graph.edges.length, communities: new Set(graph.nodes.flatMap(n => n.community === null ? [] : [n.community])).size,
  modularity: graph.graph.modularity, levels: graph.graph.iterations, buildGraphMsMedian: Math.round(runs[2]!), buildGraphMsMax: Math.round(runs[4]!) }));
