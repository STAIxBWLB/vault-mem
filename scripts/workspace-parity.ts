/**
 * Live workspace-graph parity, counts only: `bun scripts/workspace-parity.ts <vault-id> [--python PY] [--reference build-graph.py]`.
 * Runs the unchanged Python `build-graph.py --work-root` into a private temp dir and vmem's in-memory workspace build over the
 * same vault and work root, then prints set-difference counts for node ids, edge pairs, relations and attributes. It never
 * prints note text, ids or paths unless `--examples N` is passed (for local debugging only; never paste those into a PR).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { analysisInput } from "../src/analysis-input.ts";
import { resolveHome } from "../src/home.ts";
import { sourceWorkspaceRoot } from "../src/source.ts";
import { buildWorkspaceGraph } from "../src/workspace-graph.ts";
import { workspaceInput } from "../src/workspace-input.ts";

const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const vaultId = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true) ?? "personal";
const python = value("--python") ?? join(homedir(), ".maru/env/.venv/bin/python3");
const reference = value("--reference") ?? join(homedir(), "workspace/work/dev/skills/lib/build-graph.py");
const examples = Number(value("--examples") ?? 0);

const home = resolveHome(process.env).home;
const { snapshot, vault, config } = analysisInput(home, vaultId, { memory: true });
const work = sourceWorkspaceRoot(vault);
if (!work) throw new Error("vault has no registry, so no work root");
const ts = buildWorkspaceGraph(snapshot, workspaceInput(snapshot, vault, config));

const out = mkdtempSync(join(tmpdir(), "vmem-ws-parity-"));
let py: { nodes: Record<string, unknown>[]; links?: Record<string, unknown>[]; edges?: Record<string, unknown>[] };
let pyCounters: Record<string, number> = {};
try {
  const run = Bun.spawnSync([python, reference, "--target", vault.path, "--work-root", work, "--out-dir", out], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`reference failed (exit ${run.exitCode})`);
  py = JSON.parse(readFileSync(join(out, "workspace-graph.json"), "utf8"));
  // The reference prints `Work counters: {...}` as a Python dict of string keys and integers.
  const line = /Work counters: (\{.*\})/.exec(run.stdout.toString())?.[1];
  if (line) pyCounters = JSON.parse(line.replaceAll("'", '"'));
} finally { rmSync(out, { recursive: true, force: true }); }

const pyEdges = (py.links ?? py.edges ?? []) as Record<string, unknown>[];
const pair = (e: Record<string, unknown>) => [String(e.source), String(e.target)].sort().join("\u0000");
const ATTRS = ["relation", "field", "rel"] as const;
const edgeKey = (e: Record<string, unknown>) => ATTRS.map(a => e[a] === undefined ? "" : String(e[a])).join("|");
const NODE_ATTRS = ["type", "domain", "label", "source_file", "description"] as const;
const nodeKey = (n: Record<string, unknown>) => NODE_ATTRS.map(a => n[a] === undefined || n[a] === null ? "" : String(n[a])).join("|");

const diff = <T>(a: Map<string, T>, b: Map<string, T>) => [...a.keys()].filter(k => !b.has(k));
const pyNodes = new Map(py.nodes.map(n => [String(n.id), n])), tsNodes = new Map(ts.graph.nodes.map(n => [n.id, n as unknown as Record<string, unknown>]));
const pyPairs = new Map(pyEdges.map(e => [pair(e), e])), tsPairs = new Map(ts.graph.edges.map(e => [pair(e as unknown as Record<string, unknown>), e as unknown as Record<string, unknown>]));
const sharedNodes = [...pyNodes.keys()].filter(k => tsNodes.has(k)), sharedPairs = [...pyPairs.keys()].filter(k => tsPairs.has(k));
const nodeAttr = sharedNodes.filter(k => nodeKey(pyNodes.get(k)!) !== nodeKey(tsNodes.get(k)!));
const edgeAttr = sharedPairs.filter(k => edgeKey(pyPairs.get(k)!) !== edgeKey(tsPairs.get(k)!));
const byRelation = (edges: Iterable<Record<string, unknown>>) => { const r: Record<string, number> = {}; for (const e of edges) r[String(e.relation)] = (r[String(e.relation)] ?? 0) + 1; return r; };
const nodeAttrFields: Record<string, number> = {};
for (const k of nodeAttr) for (const a of NODE_ATTRS) if (String(pyNodes.get(k)![a] ?? "") !== String(tsNodes.get(k)![a] ?? "")) nodeAttrFields[a] = (nodeAttrFields[a] ?? 0) + 1;
const counterDiffs = Object.keys({ ...pyCounters, ...ts.counters }).filter(k => pyCounters[k] !== (ts.counters as Record<string, number>)[k]);
const report = {
  nodes: { python: pyNodes.size, vmem: tsNodes.size, onlyPython: diff(pyNodes, tsNodes).length, onlyVmem: diff(tsNodes, pyNodes).length, attributeDiffs: nodeAttr.length, attributeDiffsByField: nodeAttrFields },
  edges: { python: pyPairs.size, vmem: tsPairs.size, onlyPython: diff(pyPairs, tsPairs).length, onlyVmem: diff(tsPairs, pyPairs).length, relationOrAttributeDiffs: edgeAttr.length },
  relations: { python: byRelation(pyPairs.values()), vmem: ts.relations },
  vmemCounters: ts.counters,
  counterDiffs: Object.fromEntries(counterDiffs.map(k => [k, { python: pyCounters[k] ?? null, vmem: (ts.counters as Record<string, number>)[k] ?? null }])),
};
console.log(JSON.stringify(report, null, 2));
if (examples > 0) {
  const show = (label: string, items: string[]) => console.error(label, JSON.stringify(items.slice(0, examples)));
  show("onlyPythonNodes", diff(pyNodes, tsNodes)); show("onlyVmemNodes", diff(tsNodes, pyNodes));
  show("onlyPythonPairs", diff(pyPairs, tsPairs)); show("onlyVmemPairs", diff(tsPairs, pyPairs));
  show("nodeAttr", nodeAttr.map(k => `${k}: py=${nodeKey(pyNodes.get(k)!)} vmem=${nodeKey(tsNodes.get(k)!)}`));
  show("edgeAttr", edgeAttr.map(k => `${k}: py=${edgeKey(pyPairs.get(k)!)} vmem=${edgeKey(tsPairs.get(k)!)}`));
}
const clean = !report.nodes.onlyPython && !report.nodes.onlyVmem && !report.nodes.attributeDiffs && !report.edges.onlyPython && !report.edges.onlyVmem && !report.edges.relationOrAttributeDiffs && !counterDiffs.length;
process.exitCode = clean ? 0 : 1;
