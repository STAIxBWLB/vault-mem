import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

test("an org default keeps promotion available from a personal vault", async () => {
  const { plugin } = await import("../src/ui/plugin.ts");
  const { createVaultMcp } = await import("../src/mcp-vault.ts");
  const { writeFileSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-settings-promote-"))), prior = process.env.VMEM_HOME;
  try {
    const home = join(root, "home"), personal = join(root, "personal"), org = join(root, "org");
    for (const vault of [personal, org]) {
      mkdirSync(join(vault, "notes"), { recursive: true });
      writeFileSync(join(vault, "notes", "research.md"), "---\ntype: moc\ndescription: Research.\n---\n# Research\n");
    }
    writeFileSync(join(personal, "notes", "alpha.md"), "---\ntype: insight\ndomain: research\ndescription: Synthetic finding.\ntopics: ['[[research]]']\n---\n# Alpha\n\nSynthetic.\n\n## Topics\n\n- [[research]]\n");
    addVault(home, { id: "mine", path: personal, kind: "personal", write: "mcp" });
    addVault(home, { id: "team", path: org, kind: "org", write: "mcp" });
    const request = { vault: "mine", changes: { defaultVault: "team" } };
    const preview = changeSettings(home, request);
    changeSettings(home, { ...request, confirm: true, fingerprint: preview.fingerprint });
    const mcp = createVaultMcp(home, { VMEM_HOME: home });
    const result = await mcp.handlers.vmem_promote!({ path: "alpha", to: "team" }) as { fingerprint?: string; issues?: { message: string }[] };
    expect(result.fingerprint).toBeString();
    process.env.VMEM_HOME = home;
    const provider = await plugin.open({ home: root, log: () => {} });
    try {
      expect(await provider.snapshot({ panel: "note", after: 0, vault: "mine", path: "alpha" })).toMatchObject({ orgVaults: ["team"] });
      expect(await provider.action({ action: "promote", vault: "mine", path: "alpha", to: "team" })).toMatchObject({ needsConfirm: true });
    } finally { await provider.close?.(); }
  } finally { if (prior === undefined) delete process.env.VMEM_HOME; else process.env.VMEM_HOME = prior; rmSync(root, { recursive: true, force: true }); }
});
