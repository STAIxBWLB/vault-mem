import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import { assembleGraphSnapshot } from "../src/ui/graph-snapshot.ts";
import { createGraphSnapshotCache, plugin } from "../src/ui/plugin.ts";
import { addVault } from "../src/registry.ts";
const input = (text: string): AnalysisSnapshot => ({ notes: [{ path: "notes/a.md", source: text }, { path: "notes/b.md", source: "" }], today: "2026-01-01", logPath: "log", log: null, registryIds: null, reports: {} });
test("graph cache single flight, freshness, conditional cursors and LRU", async () => {
  let stamp = 1, time = 0, loads = 0, content = "[[b]]", release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const cache = createGraphSnapshotCache(() => stamp, async vault => { loads++; await gate; return assembleGraphSnapshot(input(content), vault); }, () => time);
  const one = cache.snapshot("a", {}), two = cache.snapshot("a", {});
  expect(loads).toBe(1); release();
  const [first, second] = await Promise.all([one, two]); expect(first).toEqual(second);
  expect(await cache.snapshot("a", { after: first.cursor })).toEqual({ changed: false, cursor: first.cursor });
  const next = first.next as string;
  expect((await cache.snapshot("a", { page: next })).kind).toBe("edges");
  expect(loads).toBe(1);
  time = 60_000; await cache.snapshot("a", { page: next }); expect(loads).toBe(2);
  stamp++; await cache.snapshot("a", { page: next }); expect(loads).toBe(3);
  await cache.snapshot("b", {}); await cache.snapshot("c", {}); expect(loads).toBe(5);
  expect((await cache.snapshot("a", { page: next })).kind).toBe("edges"); expect(loads).toBe(6);
  await cache.snapshot("b", {}); await cache.snapshot("c", {});
  content = "[[missing]]";
  await expect(cache.snapshot("a", { page: next })).rejects.toThrow("restart from the first page");
  await expect(cache.snapshot("a", { page: "bad" })).rejects.toThrow("restart from the first page");
  const old = await cache.snapshot("a", {}), oldNext = old.next as string;
  content = "[[other]]"; stamp++;
  await expect(cache.snapshot("a", { page: oldNext })).rejects.toThrow("restart from the first page");
});
const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-graph-ui-")));
const home = join(root, "home"), vault = join(root, "vault");
const saved = { VMEM_HOME: process.env.VMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
mkdirSync(join(vault, "notes"), { recursive: true });
writeFileSync(join(vault, "notes", "a.md"), "[[b]] [[missing]]"); writeFileSync(join(vault, "notes", "b.md"), "");
addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
afterAll(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; rmSync(root, { recursive: true, force: true }); });
test("provider graph pages, neighborhoods, paths and refusals", async () => {
  process.env.VMEM_HOME = home; process.env.AGENTHUB_HOME = join(root, "family");
  const p = await plugin.open({ home: process.env.AGENTHUB_HOME, log: () => {} });
  try {
    expect(plugin.manifest.panels.map(x => x.id)).toContain("graph");
    const first = await p.snapshot({ panel: "graph", vault: "mine", after: 0 }) as Record<string, unknown>;
    expect(first).toMatchObject({ schema: 1, vault: "mine", kind: "nodes", totals: { nodes: 3, edges: 2, placeholders: 1 } });
    expect(await p.snapshot({ panel: "graph", vault: "mine", after: first.cursor as number })).toEqual({ changed: false, cursor: first.cursor });
    const second = await p.snapshot({ panel: "graph", vault: "mine", page: first.next, after: 0 }) as Record<string, unknown>;
    expect(second).toMatchObject({ kind: "edges", offset: 0, count: 2, next: null });
    expect(await p.snapshot({ panel: "graph", vault: "nope", after: 0 })).toMatchObject({ error: expect.stringContaining("unknown vault") });
    expect(await p.snapshot({ panel: "graph", vault: "mine", page: "bad", after: 0 })).toMatchObject({ error: expect.stringContaining("restart from the first page") });
    expect(await p.snapshot({ panel: "graph", vault: "mine", neighbors: "notes/a.md", hops: 1, limit: 5, after: 0 })).toMatchObject({ neighborhood: { start: "a" } });
    expect(await p.snapshot({ panel: "graph", vault: "mine", from: "notes/a.md", to: "notes/b.md", maxHops: 2, viaHubs: true, after: 0 })).toMatchObject({ path: { found: true } });
    expect(await p.snapshot({ panel: "graph", vault: "mine", neighbors: "notes/a.md", hops: 9, after: 0 })).toMatchObject({ error: expect.stringContaining("invalid input") });
    expect(await p.snapshot({ panel: "graph", vault: "mine", from: "notes/a.md", after: 0 })).toMatchObject({ error: expect.stringContaining("invalid input") });
  } finally { await p.close?.(); }
});
test("kit graph summary and page navigation", async () => {
  const source = await Bun.file(new URL("../src/ui/panel.js", import.meta.url)).text();
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  type El = { kind: string; props: Record<string, unknown>; children: El[] };
  const el = (kind: string, props: Record<string, unknown> = {}, ...children: (El | null)[]): El => ({ kind, props, children: children.filter(Boolean) as El[] });
  let receive!: (s: unknown) => void, navigated: Record<string, unknown> | undefined;
  const root = { ...el("div"), append() {}, replaceChildren(...n: El[]) { this.children = n.filter(Boolean); }, querySelectorAll: () => [], contains: () => false, querySelector: () => null };
  const host = { tool: "vmem", mount: { append: () => {} }, onSnapshot: (fn: typeof receive) => { receive = fn; }, navigate: (_t: string, _p: string, params: Record<string, unknown>) => { navigated = params; },
    ui: { h: (k: string, pr: Record<string, unknown>, ...c: El[]) => k === "div" && pr.class === "vmem" ? root : el(k, pr, ...c), button: (label: string, onClick: () => void) => el("button", { label, onClick }), notice: (text: string) => el("notice", { text }), empty: (title: string) => el("empty", { title }) } };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: { activeElement: null }, configurable: true });
  try {
    const panel = mod.default(host); panel.show("graph", { vault: "mine" });
    receive({ vault: "mine", revision: "rev", totals: { nodes: 2, edges: 1, placeholders: 0, placeholdersOmitted: 0 }, graph: { partitioner: "leiden", resolution: 1, modularity: 0, iterations: 1, max_iterations: 256 }, kind: "nodes", offset: 0, count: 2, next: "next-token" });
    expect(JSON.stringify(root.children)).toContain("Revision: rev");
    const buttons = root.children.find(c => c.kind === "div")!.children;
    (buttons.find(b => b.props.label === "Next page")!.props.onClick as () => void)();
    expect(navigated).toEqual({ vault: "mine", page: "next-token" });
  } finally { if (saved) Object.defineProperty(globalThis, "document", saved); else delete (globalThis as { document?: unknown }).document; }
});
test("maximum graph provider replies stay within the transport limit", async () => {
  const n = 10_000, notes = Array.from({ length: n }, (_, i) => ({ path: `notes/n${String(i).padStart(5, "0")}.md`, source: Array.from({ length: 10 }, (_, j) => `[[n${String((i + j + 1) % n).padStart(5, "0")}]]`).join(" ") }));
  const s = { ...input(""), notes }, start = performance.now();
  const cache = createGraphSnapshotCache(() => 1, async v => assembleGraphSnapshot(s, v));
  let page: Record<string, unknown> = await cache.snapshot("v", {}), count = 0;
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1_048_576);
    count++;
    if (page.next === null) break;
    page = await cache.snapshot("v", { page: page.next });
  }
  console.log(`maximum graph provider assembly and paging: ${(performance.now() - start).toFixed(1)} ms (${count} pages)`);
  expect(count).toBeGreaterThan(1);
});
