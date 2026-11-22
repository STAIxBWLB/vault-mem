import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addVault, changeSettings } from "../src/registry.ts";
import { intakeEnrichment } from "../src/enrichment.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { createGraphSnapshotCache, plugin } from "../src/ui/plugin.ts";
import { assembleGraphSnapshot, assembleSemanticPages, resolveSemanticPage } from "../src/ui/graph-snapshot.ts";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import type { GraphNodeColumns } from "../src/ui/panel-types.ts";

test("provider exposes current enrichment, similar notes and private bounded semantic edges", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-semantic-"))), home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  const saved = { VMEM_HOME: process.env.VMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  mkdirSync(notes, { recursive: true });
  const content = (name: string) => `---\ntype: insight\ndescription: Synthetic ${name}.\ndomain: research\n---\n# ${name}\n${name === "a" ? "[[b]]\n" : ""}`;
  for (const id of ["a", "b", "c", "d", "e"]) writeFileSync(join(notes, `${id}.md`), content(id));
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
  process.env.VMEM_HOME = home; process.env.AGENTHUB_HOME = join(root, "family");
  const open = () => plugin.open({ home: process.env.AGENTHUB_HOME!, log: () => {} });
  try {
    const disabled = await open();
    try {
      const page = await disabled.snapshot({ panel: "graph", vault: "mine", after: 0 }) as Record<string, unknown>; expect(page.enrichment).toBeUndefined();
      expect(await disabled.snapshot({ panel: "graph", vault: "mine", similar: "notes/a.md", after: 0 })).toMatchObject({ error: expect.stringContaining("enrichment is disabled") });
    }
    finally { await disabled.close?.(); }
    const options = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, options);
    changeSettings(home, { ...options, confirm: true, fingerprint: preview.fingerprint });
    const empty = await open();
    try { expect(await empty.snapshot({ panel: "graph", vault: "mine", after: 0 })).toMatchObject({ enrichment: { model: null, embedded: 0, total: 5 } }); }
    finally { await empty.close?.(); }
    const values: Record<string, number[]> = { a: [1, 0], b: [0.8, 0.6], c: [0, 1], d: [0.7, 0.7], e: [0.9, 0.1] };
    for (const [id, value] of Object.entries(values)) intakeEnrichment(home, { vault: "mine", path: `notes/${id}.md`, contentHash: createHash("sha256").update(content(id)).digest("hex"), kind: "embedding", producer: { skill: "fixture", version: "1", model: "synthetic" }, createdAt: "2026-11-21T00:00:00.000Z", value, channel: "mcp" });
    writeFileSync(join(notes, "d.md"), content("d") + "changed\n");
    const configPath = join(home, "vmem.config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
    config.denyPaths = [join(notes, "e.md")]; writeFileSync(configPath, JSON.stringify(config));
    const provider = await open();
    try {
      const denied = await provider.snapshot({ panel: "graph", vault: "mine", after: 0 }) as Record<string, unknown>;
      expect(denied).toMatchObject({ error: expect.stringContaining("denied") });
      expect(denied.enrichment).toBeUndefined(); expect(denied.semantic).toBeUndefined();
      expect(await provider.snapshot({ panel: "graph", vault: "mine", semantic: { k: 1, minScore: 0 }, after: 0 })).toMatchObject({ error: expect.stringContaining("denied") });
      expect(await provider.snapshot({ panel: "graph", vault: "mine", similar: "notes/e.md", after: 0 })).toMatchObject({ error: expect.stringContaining("denied") });
      config.denyPaths = []; writeFileSync(configPath, JSON.stringify(config));
      writeFileSync(join(notes, "e.md"), content("e") + "changed\n");
      const graph = await provider.snapshot({ panel: "graph", vault: "mine", after: 0 }) as Record<string, any>;
      expect(graph.enrichment).toEqual({ model: "synthetic", embedded: 3, total: 5 });
      expect((graph.columns as GraphNodeColumns).id).toEqual(["a", "b", "c", "d", "e"]);
      expect(JSON.stringify(graph)).not.toContain("values");
      const graphNext = await provider.snapshot({ panel: "graph", vault: "mine", page: graph.next, after: 0 }) as Record<string, unknown>;
      expect(graphNext.enrichment).toBeUndefined();
      const result = await provider.snapshot({ panel: "graph", vault: "mine", similar: "notes/a.md", limit: 3, after: 0 }) as Record<string, any>;
      const mcp = createVaultMcp(home); const expected = await mcp.handlers.vmem_similar!({ vault: "mine", path: "notes/a.md", limit: 3 }) as { hits: unknown };
      expect(result.similar).toEqual(expected.hits);
      expect(JSON.stringify(result)).not.toContain("e.md");
      expect(await provider.snapshot({ panel: "graph", vault: "mine", similar: "notes/d.md", after: 0 })).toMatchObject({ error: expect.stringContaining("no current vector") });
      expect(await provider.snapshot({ panel: "graph", vault: "mine", similar: "notes/a.md", limit: 0, after: 0 })).toMatchObject({ error: expect.stringContaining("invalid input") });
      const semantic = await provider.snapshot({ panel: "graph", vault: "mine", semantic: { k: 1, minScore: 0.7 }, after: 0 }) as Record<string, any>;
      expect(semantic.revision).toBe(graph.revision);
      expect(await provider.snapshot({ panel: "graph", vault: "mine", semantic: { k: 1, minScore: 0.7 }, after: semantic.cursor })).toEqual({ changed: false, cursor: semantic.cursor });
      expect(semantic.semantic.source).toEqual([0]); expect(semantic.semantic.target).toEqual([1]);
      expect(semantic.semantic.score[0]).toBeCloseTo(0.8, 5);
      const all = await provider.snapshot({ panel: "graph", vault: "mine", semantic: { k: 1, minScore: 0 }, after: 0 }) as Record<string, any>;
      expect(all.semantic.source).toEqual([0, 1]); expect(all.semantic.target).toEqual([1, 2]);
      expect(all.semantic.score[1]).toBeCloseTo(0.6, 5);
      expect(JSON.stringify(semantic)).not.toContain("values");
      expect(Buffer.byteLength(JSON.stringify(semantic))).toBeLessThanOrEqual(1_048_576);
      expect(await provider.snapshot({ panel: "graph", vault: "mine", semantic: { k: 0, minScore: 0.7 }, after: 0 })).toMatchObject({ error: expect.stringContaining("k must") });
      const old = graph.next;
      intakeEnrichment(home, { vault: "mine", path: "notes/d.md", contentHash: createHash("sha256").update(content("d") + "changed\n").digest("hex"), kind: "embedding", producer: { skill: "fixture", version: "1", model: "synthetic" }, createdAt: "2026-11-21T00:00:00.000Z", value: [0.7, 0.7], channel: "mcp" });
      expect(typeof old).toBe("string");
      expect(await provider.snapshot({ panel: "graph", vault: "mine", page: old, after: 0 })).toMatchObject({ error: expect.stringContaining("restart from the first page") });
      const next = await provider.snapshot({ panel: "graph", vault: "mine", after: 0 }) as Record<string, any>;
      expect(next.revision).not.toBe(graph.revision); expect(next.enrichment.embedded).toBe(4);
    } finally { await provider.close?.(); }
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic pages bind revision, query and offsets", async () => {
  const count = 9_000, notes = Array.from({ length: count }, (_, i) => ({ path: `notes/n${String(i).padStart(5, "0")}.md`, source: "" }));
  const snapshot: AnalysisSnapshot = { notes, today: "2026-01-01", logPath: "log", log: null, registryIds: null, reports: {} };
  const vectors = notes.map(n => ({ path: n.path.slice(6), values: [1, 0] }));
  const assembly = assembleGraphSnapshot(snapshot, "v", { model: "synthetic", embedded: count, total: count, digest: "fixture", vectors });
  const pages = assembleSemanticPages(assembly, 20, 0);
  expect(pages.length).toBeGreaterThan(1);
  let offset = 0;
  for (const page of pages) {
    expect(page.offset).toBe(offset); offset += page.count;
    expect(page.semantic.source.length).toBe(page.count); expect(page.semantic.target.length).toBe(page.count); expect(page.semantic.score.length).toBe(page.count);
    expect(Buffer.byteLength(JSON.stringify(page)) + 32).toBeLessThanOrEqual(1_048_576);
    if (page.next) expect(resolveSemanticPage(assembly, pages, 20, 0, page.next).offset).toBe(offset);
  }
  const token = pages[0]!.next!;
  expect(() => resolveSemanticPage(assembly, pages, 19, 0, token)).toThrow("restart from the first page");
  expect(() => resolveSemanticPage({ ...assembly, revision: "changed" }, pages, 20, 0, token)).toThrow("restart from the first page");
  const small = assembleGraphSnapshot({ ...snapshot, notes: notes.slice(0, 2) }, "v", { model: "synthetic", embedded: 2, total: 2, digest: "small", vectors: vectors.slice(0, 2) });
  const oldToken = Buffer.from(JSON.stringify([1, "v", small.revision, "semantic", 1, 0, 0])).toString("base64url");
  let stamp = 1;
  const cache = createGraphSnapshotCache(() => stamp, async () => stamp === 1 ? small : { ...small, revision: "changed" });
  expect((await cache.snapshot("v", { semantic: { k: 1, minScore: 0 }, page: oldToken })).count).toBe(1);
  stamp++;
  await expect(cache.snapshot("v", { semantic: { k: 1, minScore: 0 }, page: oldToken })).rejects.toThrow("restart from the first page");
}, 30_000);
