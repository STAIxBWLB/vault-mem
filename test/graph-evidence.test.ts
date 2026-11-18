import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { buildGraph, graphPath } from "../src/vault-graph.ts";
import { encodedBytes, explainGraphPath, EXPLAIN_MAX_BYTES } from "../src/graph-evidence.ts";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { run } from "../src/cli.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fm = (extra = "") => `---\ntype: insight\ndomain: research\ndescription: Synthetic note.\n${extra}---\n`;
/** A snapshot as analysisInput builds it: paths relative to notes/. */
function snap(notes: Record<string, string>): AnalysisSnapshot {
  return { notes: Object.entries(notes).map(([stem, source]) => ({ path: `${stem}.md`, source })), today: "2026-11-19", logPath: "log", log: "", registryIds: null, reports: {} };
}
const A = fm() + "# A\n\n한국어 😀 [[b]] text.\n\n- [[b]] (supports): yes\n- [[b]] (contradicts): no\n\n```\n[[b]]\n```\n\n\\[[b]]\n\nSee [[b#Heading]] and [[b#^blk]].\n";
const B = fm('related: "[[a]]"\n') + "# B\n\n## Heading\n\nline ^blk\n\nBack to [[c]].\n";
const C = fm() + "# C\n";

test("G1/G2 every hop has real occurrences with UTF-8 offsets; opposing relations survive; reverse traversal is labelled", () => {
  const s = snap({ a: A, b: B, c: C }), r = explainGraphPath(s, "a", "c");
  expect(r.schemaVersion).toBe(1); expect(r.structuralOnly).toBe(true);
  expect(r.path.nodes).toEqual(["a", "b", "c"]);
  const [ab, bc] = r.hops as [typeof r.hops[0], typeof r.hops[0]];
  expect(ab.edge.kind).toBe("structural");
  for (const x of [...ab.occurrences, ...bc.occurrences]) {
    const source = x.origin.path === "notes/a.md" ? A : x.origin.path === "notes/b.md" ? B : C;
    expect(x.origin.sha256).toBe(sha(source));
    expect(Buffer.from(source).subarray(x.bytes.start, x.bytes.end).toString()).toBe(x.text);
    expect(source.split("\n")[x.line - 1]).toContain(x.text);
  }
  const legacy = ab.occurrences.filter(x => x.kind === "legacy_graph_match" && x.origin.path === "notes/a.md");
  expect(legacy.map(x => [x.relation, x.authored])).toEqual([["wiki_link", true], ["supports", true], ["contradicts", true], ["wiki_link", false], ["wiki_link", false]]);
  expect(legacy.every(x => x.traversal === "forward" && x.authoredFrom === "a" && x.authoredTo === "b")).toBe(true);
  const annotations = ab.occurrences.filter(x => x.kind === "annotation");
  expect(annotations.map(x => x.anchor ?? x.field)).toEqual([{ heading: "Heading" }, { block: "blk" }, "related"]);
  expect(annotations.find(x => x.source === "frontmatter")).toMatchObject({ authoredFrom: "b", authoredTo: "a", traversal: "reverse" });
  expect(JSON.stringify(r)).not.toContain("confidence");
});

test("G2 annotations never change reachability: a frontmatter-only or anchored-only reference adds no edge", () => {
  const s = snap({ x: fm('related: "[[y]]"\n') + "# X\n\nSee [[y#H]].\n", y: fm() + "# Y\n\n## H\n" });
  expect(graphPath(buildGraph(s), "x", "y").found).toBe(false);
  const r = explainGraphPath(s, "x", "y");
  expect(r.path.found).toBe(false); expect(r.hops).toEqual([]);
});

test("G3 byte-identical JSON for the same input; a changed source changes the identity; graph/path stay unchanged", () => {
  const s = snap({ a: A, b: B, c: C });
  const before = JSON.stringify(graphPath(buildGraph(s), "a", "c")), communities = buildGraph(s).nodes.map(n => n.community);
  expect(JSON.stringify(explainGraphPath(s, "a", "c"))).toBe(JSON.stringify(explainGraphPath(snap({ c: C, b: B, a: A }), "a", "c")));
  expect(explainGraphPath(snap({ a: A + "x", b: B, c: C }), "a", "c").snapshotHash).not.toBe(explainGraphPath(s, "a", "c").snapshotHash);
  expect(explainGraphPath(s, "a", "c", { viaHubs: true }).snapshotHash).not.toBe(explainGraphPath(s, "a", "c").snapshotHash);
  expect(JSON.stringify(graphPath(buildGraph(s), "a", "c"))).toBe(before);
  expect(buildGraph(s).nodes.map(n => n.community)).toEqual(communities);
});

test("G4 per-hop and byte limits expose every omission", () => {
  const many = fm() + "# M\n\n" + Array.from({ length: 30 }, () => "[[n]]").join("\n") + "\n";
  const r = explainGraphPath(snap({ m: many, n: fm() + "# N\n" }), "m", "n");
  expect(r.hops[0]!.occurrences).toHaveLength(20); expect(r.hops[0]!.omitted).toBe(10); expect(r.truncated).toBe(true);
  const long = "x".repeat(400);
  const notes: Record<string, string> = {};
  for (let i = 0; i < 7; i++) notes[`n${i}`] = fm() + `# N\n\n${i < 6 ? Array.from({ length: 40 }, () => `[[n${i + 1}|${long}]]`).join("\n") : ""}\n`;
  const big = explainGraphPath(snap(notes), "n0", "n6");
  expect(encodedBytes(big)).toBeLessThanOrEqual(EXPLAIN_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(big) }] } }))).toBeLessThanOrEqual(EXPLAIN_MAX_BYTES);
  // Escaping counts: quotes and backslashes in link text double when the JSON is embedded as MCP text content.
  const quoted: Record<string, string> = { q: fm() + "# Q\n\n" + Array.from({ length: 200 }, () => `[[r|${'"\\'.repeat(100)}]]`).join("\n") + "\n", r: fm() + "# R\n" };
  const escaped = explainGraphPath(snap(quoted), "q", "r");
  expect(encodedBytes(escaped)).toBeLessThanOrEqual(EXPLAIN_MAX_BYTES);
  expect(escaped.hops[0]!.occurrences.length + escaped.hops[0]!.omitted).toBe(200);
  expect(big.truncated).toBe(true);
  expect(big.hops.reduce((sum, hop) => sum + hop.occurrences.length + hop.omitted, 0)).toBe(6 * 40);
});

test("G4/G5 CLI JSON and MCP share one implementation; reads write nothing; tool is read-only", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-explain-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  for (const [stem, source] of Object.entries({ a: A, b: B, c: C })) writeFileSync(join(vault, "notes", `${stem}.md`), source);
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "none" });
  const env = { HOME: root, VMEM_HOME: home, AGENTHUB_HOME: join(root, "family"), AMEM_HOME: join(root, "memory"), PATH: process.env.PATH };
  const before = readdirSync(vault, { recursive: true }).sort();
  const cli = run(["graph", "explain", "mine", "a", "c", "--json"], env);
  expect(cli.code).toBe(0);
  const mcp = createVaultMcp(home, env), tool = mcp.tools.find(t => t.name === "vmem_graph_explain")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(JSON.parse(cli.text)).toEqual(await mcp.handlers.vmem_graph_explain!({ vault: "mine", from: "a", to: "c" }) as object);
  expect(JSON.parse(cli.text)).toEqual(explainGraphPath(analysisInput(home, "mine").snapshot, "a", "c"));
  const human = run(["graph", "explain", "mine", "a", "c"], env);
  expect(human.text).toContain("hop 1: a -> b"); expect(human.text).toContain("reverse");
  expect(readdirSync(vault, { recursive: true }).sort()).toEqual(before);
  expect(() => run(["graph", "explain", "mine", "a", "c", "--hops", "2"], env)).toThrow("applies only");
});

test("annotation addresses use the navigation note key (b.md, notes/b) like resolveLinks", () => {
  const s = snap({ a: fm() + "# A\n\n[[b]]\n\n[[b.md#Heading]] and [[notes/b#Heading]]\n", b: fm() + "# B\n\n## Heading\n" });
  const occurrences = explainGraphPath(s, "a", "b").hops[0]!.occurrences;
  expect(occurrences.map(x => [x.kind, x.text])).toEqual([["legacy_graph_match", "[[b]]"], ["annotation", "[[b.md#Heading]]"], ["annotation", "[[notes/b#Heading]]"]]);
});

test("location work is linear: many links to one neighbour stay fast and are counted, not located", () => {
  const body = Array.from({ length: 20000 }, () => "[[b]]").join("\n");
  const s = snap({ a: fm() + "# A\n\n" + body + "\n", b: fm() + "# B\n" });
  const started = performance.now(), r = explainGraphPath(s, "a", "b");
  expect(r.hops[0]!.occurrences).toHaveLength(20); expect(r.hops[0]!.omitted).toBe(19980);
  expect(performance.now() - started).toBeLessThan(1500);
});
