import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addVault, changeSettings, settingsSnapshot } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { buildGraph } from "../src/vault-graph.ts";
import { analysisInput } from "../src/analysis-input.ts";

test("settings preview is read-only and confirmation binds the current configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "vmem-settings-"));
  try {
    const home = join(root, "home"), vault = join(root, "vault");
    mkdirSync(join(vault, "notes"), { recursive: true });
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "none" });
    const before = readFileSync(join(home, "vmem.config.json"), "utf8");
    const changes = { write: "mcp" as const, defaultVault: "mine", piiPatterns: ["private"], graphResolution: 2 };
    const preview = changeSettings(home, { vault: "mine", changes });
    expect(readFileSync(join(home, "vmem.config.json"), "utf8")).toBe(before);
    expect(() => changeSettings(home, { vault: "mine", changes, confirm: true, fingerprint: "stale" })).toThrow(/preview.*stale/);
    expect(readFileSync(join(home, "vmem.config.json"), "utf8")).toBe(before);
    expect(changeSettings(home, { vault: "mine", changes, confirm: true, fingerprint: preview.fingerprint }).applied).toBe(true);
    expect(settingsSnapshot(home, "mine")).toMatchObject({ write: "mcp", defaultVault: "mine", piiPatterns: ["private"], graphResolution: 2 });
    expect(buildGraph(analysisInput(home, "mine").snapshot).graph.resolution).toBe(2);
    expect(() => changeSettings(home, { vault: "mine", changes: { graphResolution: 0 } })).toThrow(/resolution/);
    expect(() => changeSettings(home, { vault: "missing", changes })).toThrow(/registered/);
    expect(JSON.parse(run(["settings", "mine", "--json"], { VMEM_HOME: home }).text).graphResolution).toBe(2);
    expect(() => run(["settings", "mine", "--unknown"], { VMEM_HOME: home })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("console settings action previews and requires confirmation", async () => {
  const { plugin } = await import("../src/ui/plugin.ts");
  const root = mkdtempSync(join(tmpdir(), "vmem-settings-ui-"));
  const previous = process.env.VMEM_HOME;
  try {
    const home = join(root, "home"), vault = join(root, "vault");
    mkdirSync(join(vault, "notes"), { recursive: true });
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "none" });
    process.env.VMEM_HOME = home;
    const provider = await plugin.open({ home: root, log: () => {} });
    try {
      expect(await provider.snapshot({ panel: "settings", after: 0 })).toMatchObject({ vault: "mine", write: "none", defaultVaultExplicit: false });
      const request = { action: "settings", changes: { defaultVault: "mine", write: "mcp", piiPatterns: [], graphResolution: 1 } };
      const preview = await provider.action(request);
      expect(preview).toMatchObject({ ok: false, needsConfirm: true, preview: ['write: "mcp"'] });
      expect(settingsSnapshot(home, "mine").write).toBe("none");
      if (!("fingerprint" in preview) || typeof preview.fingerprint !== "string") throw new Error("missing settings preview fingerprint");
      expect(await provider.action({ ...request, confirmed: true, fingerprint: preview.fingerprint })).toMatchObject({ ok: true });
      expect(settingsSnapshot(home, "mine").write).toBe("mcp");
      const config = JSON.parse(readFileSync(join(home, "vmem.config.json"), "utf8"));
      expect(config).not.toHaveProperty("defaultVault");
      expect(config).not.toHaveProperty("piiPatterns");
      expect(config).not.toHaveProperty("version");
      expect(config.vaults[0]).not.toHaveProperty("graph");
      expect(() => changeSettings(home, { vault: "mine", changes: { write: "mcp" } })).toThrow(/no values changed/);
      expect(await provider.action({ action: "settings", changes: { graphResolution: 0 } })).toMatchObject({ ok: false });
    } finally { await provider.close?.(); }
  } finally { if (previous === undefined) delete process.env.VMEM_HOME; else process.env.VMEM_HOME = previous; rmSync(root, { recursive: true, force: true }); }
});
