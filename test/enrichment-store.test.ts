import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, changeSettings, loadRegistry } from "../src/registry.ts";
import { readEnrichmentStore, writeEnrichmentRecord, type EnrichmentRecord } from "../src/enrichment-store.ts";

test("sidecar binds vectors to one vault, model and dimension", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-store-")));
  try {
    const home = join(root, "home"), path = join(root, "vault");
    mkdirSync(join(path, "notes"), { recursive: true });
    addVault(home, { id: "mine", path, kind: "personal", write: "mcp" });
    const request = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, request);
    changeSettings(home, { ...request, confirm: true, fingerprint: preview.fingerprint });
    const config = loadRegistry(home), vault = config.vaults[0]!;
    const record: EnrichmentRecord = { path: "notes/example.md", contentHash: "a".repeat(64), kind: "embedding", producer: { skill: "fixture", version: "1", model: "sample" }, createdAt: "2026-11-21T00:00:00.000Z", value: [1, 2] };
    expect(readEnrichmentStore(home, vault, config.vaults, []).records).toEqual([]);
    expect(writeEnrichmentRecord(home, vault, record, () => {})).toMatchObject({ applied: true, issues: [] });
    expect(readEnrichmentStore(home, vault, config.vaults, []).records).toEqual([record]);
    expect(readEnrichmentStore(home, vault, config.vaults, []).model).toBe("sample");
    expect(() => writeEnrichmentRecord(home, vault, { ...record, contentHash: "b".repeat(64) }, () => { throw new Error("source is stale"); })).toThrow("source is stale");
    expect(readEnrichmentStore(home, vault, config.vaults, []).records).toEqual([record]);
    expect(() => writeEnrichmentRecord(home, vault, { ...record, producer: { ...record.producer, model: "other" } }, () => {})).toThrow(/model or dimension/);
    expect(() => writeEnrichmentRecord(home, vault, { ...record, value: [1] }, () => {})).toThrow(/model or dimension/);
    expect(() => writeEnrichmentRecord(home, vault, { ...record, value: [0, 0] }, () => {})).toThrow(/invalid/);
    chmodSync(join(home, "enrichment"), 0o755);
    expect(() => readEnrichmentStore(home, vault, config.vaults, [])).toThrow(/not private/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("re-intake replaces stale vectors and text without growing records", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-replace-")));
  try {
    const home = join(root, "home"), path = join(root, "vault"); mkdirSync(join(path, "notes"), { recursive: true });
    addVault(home, { id: "mine", path, kind: "personal", write: "mcp" });
    const settings = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, settings);
    changeSettings(home, { ...settings, confirm: true, fingerprint: preview.fingerprint });
    const config = loadRegistry(home), vault = config.vaults[0]!;
    const common = { path: "notes/example.md", contentHash: "a".repeat(64), producer: { skill: "fixture", version: "1", model: "sample" }, createdAt: "2026-11-21T00:00:00.000Z" };
    for (const kind of ["embedding", "summary", "community-label"] as const) {
      const record: EnrichmentRecord = { ...common, kind, value: kind === "embedding" ? [0.1, 0.2] : "first" };
      writeEnrichmentRecord(home, vault, record, () => {});
      writeEnrichmentRecord(home, vault, { ...record, contentHash: "b".repeat(64), value: kind === "embedding" ? [0.3, 0.4] : "second" }, () => {});
    }
    const store = readEnrichmentStore(home, vault, config.vaults, []);
    expect(store.records).toHaveLength(3);
    expect(store.records.every(r => r.contentHash === "b".repeat(64))).toBe(true);
    const vector = store.records.find(r => r.kind === "embedding")!.value as number[];
    expect(vector).toEqual([Math.fround(0.3), Math.fround(0.4)]);
    expect(() => writeEnrichmentRecord(home, vault, { ...common, kind: "embedding", value: [1e100, 1] }, () => {})).toThrow(/overflows Float32/);
    expect(() => writeEnrichmentRecord(home, vault, { ...common, kind: "embedding", value: [1e-100, 1e-100] }, () => {})).toThrow(/becomes zero/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded sidecar capacity accommodates 10000 worst-case 1536-dimensional records", async () => {
  const { MAX_ENRICHMENT_STORE_BYTES, MAX_ENRICHMENT_RECORDS } = await import("../src/enrichment-store.ts");
  const record = { path: `notes/${'"'.repeat(1015)}.md`, contentHash: "a".repeat(64), kind: "embedding", producer: { skill: '"'.repeat(128), version: '"'.repeat(128), model: '"'.repeat(256) }, createdAt: "2026-11-21T00:00:00.000Z", value: { encoding: "float32le", data: "A".repeat(8192) } };
  const worstRecordBytes = Buffer.byteLength(JSON.stringify(record)) + 1;
  expect(MAX_ENRICHMENT_RECORDS).toBeGreaterThanOrEqual(10000);
  expect(worstRecordBytes * 10000 + 1024).toBeLessThan(MAX_ENRICHMENT_STORE_BYTES);
});

test("oversize sidecar is refused before reading its payload", async () => {
  const fs = await import("node:fs");
  const { spyOn } = await import("bun:test");
  const { MAX_ENRICHMENT_STORE_BYTES } = await import("../src/enrichment-store.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-budget-")));
  try {
    const home = join(root, "home"), vaultPath = join(root, "vault"); mkdirSync(join(vaultPath, "notes"), { recursive: true });
    addVault(home, { id: "mine", path: vaultPath, kind: "personal", write: "mcp" });
    const settings = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, settings);
    changeSettings(home, { ...settings, confirm: true, fingerprint: preview.fingerprint });
    const config = loadRegistry(home), vault = config.vaults[0]!;
    writeEnrichmentRecord(home, vault, { path: "notes/a.md", contentHash: "a".repeat(64), kind: "embedding", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: [1, 0] }, () => {});
    const name = fs.readdirSync(join(home, "enrichment")).find(n => n.endsWith(".json"))!;
    fs.truncateSync(join(home, "enrichment", name), MAX_ENRICHMENT_STORE_BYTES + 1);
    let reads = 0; const original = fs.readSync;
    const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => { if (fs.fstatSync(args[0]).size > MAX_ENRICHMENT_STORE_BYTES) reads++; return original(...args); }) as typeof fs.readSync);
    try { expect(() => readEnrichmentStore(home, vault, config.vaults, [])).toThrow(/exceeds its byte limit/); expect(reads).toBe(0); }
    finally { spy.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
