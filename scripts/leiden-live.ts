/**
 * Live Leiden metrics, counts only: `bun scripts/leiden-live.ts <vault-id> [--python PY] [--reference build-graph.py]`.
 * Builds the vault graph in memory, then runs the unchanged Python `build-graph.py` (graspologic Leiden, seed 42) into a
 * private temp dir on the same vault and prints modularity, community count, largest share, connectivity, clustering time
 * and NMI against the Python partition. Never prints note ids or text.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { analysisInput } from "../src/analysis-input.ts";
import { resolveHome } from "../src/home.ts";
import { buildGraph, leidenCommunities } from "../src/vault-graph.ts";

const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const vaultId = args[0] && !args[0].startsWith("--") ? args[0] : "personal";
const python = value("--python") ?? join(homedir(), ".maru/env/.venv/bin/python3");
const reference = value("--reference") ?? join(homedir(), "workspace/work/dev/skills/lib/build-graph.py");
const { snapshot, vault } = analysisInput(resolveHome(process.env).home, vaultId, { memory: true });
const graph = buildGraph(snapshot);
const hubs = new Set(graph.nodes.filter(n => ["moc", "bu"].includes(n.type)).map(n => n.id));
const started = performance.now();
const timed = leidenCommunities(graph.nodes.map(n => n.id), graph.edges.map(e => [e.source, e.target] as const), { exclude: hubs });
const ms = performance.now() - started;
const ours = new Map(graph.nodes.flatMap(n => n.community === null ? [] : [[n.id, n.community] as const]));
const groups = new Map<number, string[]>();
for (const [id, c] of ours) groups.set(c, [...(groups.get(c) ?? []), id]);
const adj = new Map<string, string[]>();
for (const e of graph.edges) { adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]); adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]); }
let disconnected = 0;
for (const members of groups.values()) {
  const inside = new Set(members), seen = new Set([members[0]!]), stack = [members[0]!];
  while (stack.length) for (const u of adj.get(stack.pop()!) ?? []) if (inside.has(u) && !seen.has(u)) { seen.add(u); stack.push(u); }
  if (seen.size !== members.length) disconnected++;
}
const nonSingleton = [...groups.values()].filter(g => g.length > 1);
const out = mkdtempSync(join(tmpdir(), "vmem-leiden-"));
let theirs = new Map<string, number>(), pythonPartitioner = "";
try {
  const run = Bun.spawnSync([python, reference, "--target", vault.path, "--out-dir", out], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`reference failed (exit ${run.exitCode})`);
  // build-graph.py names the export vault-graph.json only when --out-dir is called `reports`; elsewhere it is graph.json.
  const file = ["vault-graph.json", "graph.json"].map(name => join(out, name)).find(path => { try { readFileSync(path); return true; } catch { return false; } });
  if (!file) throw new Error("reference wrote no graph JSON");
  const py = JSON.parse(readFileSync(file, "utf8")) as { graph?: { partitioner?: string }; nodes: { id: string; community?: number | null }[] };
  pythonPartitioner = py.graph?.partitioner ?? "";
  theirs = new Map(py.nodes.flatMap(n => n.community === undefined || n.community === null ? [] : [[n.id, n.community] as const]));
} finally { rmSync(out, { recursive: true, force: true }); }
function nmi(a: Map<string, number>, b: Map<string, number>): number {
  const ids = [...a.keys()].filter(id => b.has(id)), n = ids.length, joint = new Map<string, number>(), ca = new Map<number, number>(), cb = new Map<number, number>();
  for (const id of ids) { const x = a.get(id)!, y = b.get(id)!; joint.set(`${x},${y}`, (joint.get(`${x},${y}`) ?? 0) + 1); ca.set(x, (ca.get(x) ?? 0) + 1); cb.set(y, (cb.get(y) ?? 0) + 1); }
  const h = (c: Map<number, number>) => -[...c.values()].reduce((s, v) => s + (v / n) * Math.log(v / n), 0);
  let mi = 0;
  for (const [k, v] of joint) { const [x, y] = k.split(",").map(Number) as [number, number]; mi += (v / n) * Math.log((v * n) / (ca.get(x)! * cb.get(y)!)); }
  return (2 * mi) / (h(ca) + h(cb));
}
const clustered = ours.size;
console.log(JSON.stringify({
  nodes: graph.nodes.length, hubsExcluded: hubs.size, clustered, edges: graph.edges.length,
  modularity: graph.graph.modularity, communities: groups.size, nonSingletonCommunities: nonSingleton.length,
  largestShare: Math.round(Math.max(...[...groups.values()].map(g => g.length)) / clustered * 1000) / 1000,
  disconnectedCommunities: disconnected, levels: graph.graph.iterations, clusteringMs: Math.round(ms),
  repeatIdentical: [...timed.membership].every(([id, c]) => ours.get(id) === c),
  python: { partitioner: pythonPartitioner, communities: new Set(theirs.values()).size, sharedNodes: [...ours.keys()].filter(id => theirs.has(id)).length },
  nmiVsPython: Math.round(nmi(ours, theirs) * 1000) / 1000,
}, null, 2));
