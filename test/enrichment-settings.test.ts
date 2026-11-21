import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, changeSettings, settingsSnapshot } from "../src/registry.ts";

test("enrichment is disabled by default and enabled through confirmed settings", () => {
  const root = mkdtempSync(join(tmpdir(), "vmem-enrichment-settings-"));
  try {
    const home = join(root, "home"), vault = join(root, "vault");
    mkdirSync(join(vault, "notes"), { recursive: true });
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    expect(settingsSnapshot(home, "mine").enrichmentEnabled).toBe(false);
    const request = { vault: "mine", changes: { enrichmentEnabled: true } };
    const preview = changeSettings(home, request);
    expect(settingsSnapshot(home, "mine").enrichmentEnabled).toBe(false);
    expect(() => changeSettings(home, { ...request, confirm: true, fingerprint: "stale" })).toThrow(/stale/);
    changeSettings(home, { ...request, confirm: true, fingerprint: preview.fingerprint });
    expect(settingsSnapshot(home, "mine").enrichmentEnabled).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "vmem.config.json"), "utf8"))).toMatchObject({ version: 6, vaults: [{ enrichment: { enabled: true } }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
