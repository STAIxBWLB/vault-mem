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
