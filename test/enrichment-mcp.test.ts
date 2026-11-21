import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, changeSettings } from "../src/registry.ts";
import { validArguments } from "../src/mcp.ts";
import { createVaultMcp, VMEM_TOOL_NAMES } from "../src/mcp-vault.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-mcp-"))), home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  const alpha = "---\ntype: insight\ndescription: Lantern note.\ndomain: research\ntopics: ['[[research]]']\n---\n# Alpha\nlantern\n\n## Topics\n";
  const beta = "---\ntype: insight\ndescription: Moon note.\ndomain: research\n---\n# Beta\nmoon\n";
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Research.\n---\n# Research\n");
  writeFileSync(join(notes, "alpha.md"), alpha); writeFileSync(join(notes, "beta.md"), beta);
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
  const settings = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, settings);
  changeSettings(home, { ...settings, confirm: true, fingerprint: preview.fingerprint });
  return { root, home, vault, notes, alpha, beta };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("MCP exposes bounded enrichment schemas and runs work, intake, get, similar and hybrid search", async () => {
  const f = fixture();
  try {
    const server = createVaultMcp(f.home, { VMEM_HOME: f.home }), schema = (name: string) => server.tools.find(t => t.name === name)!.inputSchema;
    expect(VMEM_TOOL_NAMES).toContain("vmem_enrichment_work");
    expect(VMEM_TOOL_NAMES).toContain("vmem_enrichment_intake");
    expect(VMEM_TOOL_NAMES).toContain("vmem_enrichment_get");
    expect(VMEM_TOOL_NAMES).toContain("vmem_similar");
    expect(validArguments({ query: "lantern", model: "test", vector: [1, 0] }, schema("vmem_search"))).toBe(true);
    expect(validArguments({ query: "lantern", model: "test", vector: Array(4097).fill(0) }, schema("vmem_search"))).toBe(false);
    expect(validArguments({ kind: "fact", path: "alpha", contentHash: hash(f.alpha), producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: [{ op: "assert", subject: "s:alpha", evidence: [{ source: "notes/alpha.md", sha256: hash(f.alpha), quote: "lantern" }] }] }, schema("vmem_enrichment_intake"))).toBe(true);

    const intake = server.handlers.vmem_enrichment_intake!;
    expect(await intake({ vault: "mine", path: "alpha", contentHash: hash(f.alpha), kind: "fact", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: [{ op: "declare", subject: "s:alpha" }, { op: "assert", subject: "s:alpha", relation: "status", value: "active", kind: "state", from: "2026", to: "open", source: ["mem:fixture"] }] })).toMatchObject({ ok: true, applied: true });
    expect(await intake({ vault: "mine", path: "alpha", contentHash: hash(f.alpha), kind: "inferred-link", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: { target: "beta" } })).toMatchObject({ ok: true, applied: true });
    expect(await intake({ vault: "mine", path: "alpha", contentHash: hash(f.alpha), kind: "embedding", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: [1, 0] })).toMatchObject({ ok: true, applied: true });
    expect(await intake({ vault: "mine", path: "beta", contentHash: hash(f.beta), kind: "embedding", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: [0.8, 0.2] })).toMatchObject({ ok: true, applied: true });
    expect(await server.handlers.vmem_enrichment_work!({ vault: "mine", kind: "embedding" })).toMatchObject({ kind: "embedding", items: [expect.objectContaining({ path: "notes/research.md" })] });
    expect(await server.handlers.vmem_enrichment_get!({ vault: "mine", path: "alpha", kind: "embedding" })).toMatchObject({ status: "current", value: [1, 0] });
    expect(await server.handlers.vmem_similar!({ vault: "mine", path: "alpha" })).toMatchObject({ hits: [{ path: "beta.md" }] });
    expect(await server.handlers.vmem_search!({ vault: "mine", query: "lantern", model: "test", vector: [1, 0] })).toMatchObject({ hits: [{ path: "alpha.md" }, { path: "beta.md" }] });
    expect(await server.handlers.vmem_search!({ vault: "mine", query: "lantern", model: "test" })).toMatchObject({ refused: true });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("enrichment MCP tools reject a changed startup vault binding", async () => {
  const f = fixture();
  try {
    const server = createVaultMcp(f.home, { VMEM_HOME: f.home }), settings = { vault: "mine", changes: { enrichmentEnabled: false } }, preview = changeSettings(f.home, settings);
    changeSettings(f.home, { ...settings, confirm: true, fingerprint: preview.fingerprint });
    expect(await server.handlers.vmem_enrichment_work!({ vault: "mine", kind: "summary" })).toMatchObject({ refused: true, issues: [{ message: expect.stringContaining("binding changed") }] });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
