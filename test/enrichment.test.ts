import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, changeSettings } from "../src/registry.ts";
import { intakeEnrichment, listEnrichmentWork, readEnrichment } from "../src/enrichment.ts";

test("work list and intake follow source content hashes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-")));
  try {
    const home = join(root, "home"), vault = join(root, "vault"), file = join(vault, "notes", "alpha.md");
    mkdirSync(join(vault, "notes"), { recursive: true });
    const note = "---\ntype: insight\ndescription: A fixture.\ndomain: research\n---\n# Alpha\n";
    writeFileSync(file, note);
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const settings = { vault: "mine", changes: { enrichmentEnabled: true } }, p = changeSettings(home, settings);
    changeSettings(home, { ...settings, confirm: true, fingerprint: p.fingerprint });
    const { analysisInput } = require("../src/analysis-input.ts") as typeof import("../src/analysis-input.ts");
    const { lintVault } = require("../src/vault-lint.ts") as typeof import("../src/vault-lint.ts");
    expect(lintVault(analysisInput(home, "mine", { hints: true }).snapshot).findings.L18).toEqual([expect.stringContaining("embedding missing")]);
    const hash = createHash("sha256").update(note).digest("hex");
    expect(listEnrichmentWork(home, { vault: "mine", kind: "embedding" }).items).toEqual([{ path: "notes/alpha.md", contentHash: hash }]);
    const request = { vault: "mine", path: "notes/alpha.md", contentHash: hash, kind: "embedding" as const, producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: [1, 2], channel: "mcp" as const };
    expect(() => intakeEnrichment(home, { ...request, producer: { skill: "", version: "1", model: "test" } })).toThrow(/invalid/);
    expect(() => intakeEnrichment(home, { ...request, kind: "summary", value: "password=fixtureSecret123" })).toThrow(/secret or PII/);
    expect(intakeEnrichment(home, request)).toMatchObject({ ok: true, applied: true, contentHash: hash });
    expect(listEnrichmentWork(home, { vault: "mine", kind: "embedding" }).items).toEqual([]);
    expect(readEnrichment(home, { vault: "mine", path: "alpha", kind: "embedding" })).toMatchObject({ status: "current", contentHash: hash });
    writeFileSync(file, `${note}\nchanged\n`);
    expect(lintVault(analysisInput(home, "mine", { hints: true }).snapshot).findings.L18).toEqual([expect.stringContaining("embedding stale")]);
    expect(listEnrichmentWork(home, { vault: "mine", kind: "embedding" }).items).toHaveLength(1);
    expect(readEnrichment(home, { vault: "mine", path: "alpha", kind: "embedding" })).toMatchObject({ status: "stale" });
    expect(() => intakeEnrichment(home, request)).toThrow(/stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hybrid search uses only current vectors and falls back when none exist", async () => {
  const { VaultIndex } = await import("../src/vault-index.ts");
  const { hybridSearch, similarNotes } = await import("../src/enrichment-query.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-query-")));
  try {
    const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
    mkdirSync(notes, { recursive: true });
    const a = "---\ntype: insight\ndescription: Lantern.\ndomain: research\n---\n# Alpha\nlantern\n", b = "---\ntype: insight\ndescription: Moon.\ndomain: research\n---\n# Beta\nmoon\n";
    writeFileSync(join(notes, "alpha.md"), a); writeFileSync(join(notes, "beta.md"), b);
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const settings = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, settings);
    changeSettings(home, { ...settings, confirm: true, fingerprint: preview.fingerprint });
    const config = loadRegistry(home), index = new VaultIndex(home, config.vaults[0]!, [vault], { memory: true });
    try {
      index.scan();
      const vector = { model: "test", values: [1, 0] };
      expect(hybridSearch(home, "mine", index, "lantern", { limit: 20 }, vector)).toEqual(index.search("lantern", { limit: 20 }));
      for (const [path, source, value] of [["alpha", a, [1, 0]], ["beta", b, [0.8, 0.2]]] as const) {
        intakeEnrichment(home, { vault: "mine", path, contentHash: createHash("sha256").update(source).digest("hex"), kind: "embedding", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value, channel: "mcp" });
      }
      expect(hybridSearch(home, "mine", index, "lantern", { limit: 20 }, vector).map(h => h.path)).toContain("beta.md");
      expect(similarNotes(home, "mine", index, "alpha")[0]?.path).toBe("beta.md");
      expect(() => hybridSearch(home, "mine", index, "lantern", {}, { model: "wrong", values: [1, 0] })).toThrow(/model or dimension/);
      writeFileSync(join(notes, "beta.md"), `${b}\nchanged\n`); index.scan();
      expect(similarNotes(home, "mine", index, "alpha")).toEqual([]);
    } finally { index.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fact intake uses the assertion journal and inferred links require proposal confirmation", async () => {
  const { applyProposal, previewProposalApply } = await import("../src/proposal-provider.ts");
  const { readJournal, evaluateAssertions } = await import("../src/assertions.ts");
  const { analysisInput } = await import("../src/analysis-input.ts");
  const { buildGraph } = await import("../src/vault-graph.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-intake-")));
  try {
    const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
    mkdirSync(notes, { recursive: true });
    const note = "---\ntype: insight\ndescription: A fixture.\ndomain: research\ntopics: ['[[research]]']\n---\n# Alpha\n\nContent.\n\n## Topics\n\n- [[research]]\n";
    writeFileSync(join(notes, "alpha.md"), note);
    writeFileSync(join(notes, "beta.md"), note.replace("# Alpha", "# Beta"));
    writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Research.\n---\n# Research\n");
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const settings = { vault: "mine", changes: { enrichmentEnabled: true } }, preview = changeSettings(home, settings);
    changeSettings(home, { ...settings, confirm: true, fingerprint: preview.fingerprint });
    const base = { vault: "mine", path: "alpha", contentHash: createHash("sha256").update(note).digest("hex"), producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", channel: "mcp" as const };
    const fact = intakeEnrichment(home, { ...base, kind: "fact", value: [{ op: "declare", subject: "s:alpha" }, { op: "assert", subject: "s:alpha", relation: "status", value: "active", kind: "state", from: "2026", to: "open", source: ["mem:fixture"] }] });
    expect(fact).toMatchObject({ applied: true, ok: true });
    expect(() => intakeEnrichment(home, { ...base, kind: "fact", value: [{ op: "assert", subject: "s:alpha", relation: "status", value: "active", kind: "state", from: "2026", to: "open", source: ["mem:fixture"] }] })).toThrow(/already has an intake record/);
    expect(evaluateAssertions(readJournal(vault), {}).items[0]?.origin).toMatchObject({ path: "notes/alpha.md", sha256: base.contentHash, status: "unverified" });
    const modified = `${note}\nOther content.\n`;
    writeFileSync(join(notes, "alpha.md"), modified);
    const newer = { ...base, contentHash: createHash("sha256").update(modified).digest("hex") };
    const newFact = { kind: "fact" as const, value: [{ op: "assert", subject: "s:alpha", relation: "status", value: "new", kind: "state", from: "2026", to: "open", source: ["mem:fixture"] }] };
    expect(intakeEnrichment(home, { ...newer, ...newFact })).toMatchObject({ applied: true });
    writeFileSync(join(notes, "alpha.md"), note);
    expect(() => intakeEnrichment(home, { ...base, ...newFact })).toThrow(/already has an intake record/);
    const link = intakeEnrichment(home, { ...base, kind: "inferred-link", value: { target: "beta" } });
    expect(link).toMatchObject({ applied: true, ok: true });
    if (!("receipt" in link) || !link.receipt || !("id" in link.receipt)) throw new Error("expected proposal receipt");
    const id = link.receipt.id;
    const proposal = previewProposalApply(home, { vault: "mine", id }, { channel: "mcp" });
    expect(applyProposal(home, { vault: "mine", id, fingerprint: proposal.fingerprint }, { channel: "mcp" }).applied).toBe(true);
    expect(buildGraph(analysisInput(home, "mine").snapshot).edges.find(e => e.source === "alpha" && e.target === "beta")?.confidence_tag).toBe("INFERRED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uncertain reservations require fingerprint-bound reconciliation before retry", async () => {
  const { writeEnrichmentRecord } = await import("../src/enrichment-store.ts");
  const { reconcileEnrichment } = await import("../src/enrichment.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-reconcile-")));
  try {
    const home = join(root, "home"), vault = join(root, "vault"), file = join(vault, "notes", "alpha.md");
    mkdirSync(join(vault, "notes"), { recursive: true });
    const source = "---\ntype: insight\ndescription: Fixture.\ndomain: research\n---\n# Alpha\n"; writeFileSync(file, source);
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const setting = { vault: "mine", changes: { enrichmentEnabled: true } }, settingsPreview = changeSettings(home, setting);
    changeSettings(home, { ...setting, confirm: true, fingerprint: settingsPreview.fingerprint });
    const spec = loadRegistry(home).vaults[0]!, hash = createHash("sha256").update(source).digest("hex");
    writeEnrichmentRecord(home, spec, { path: "notes/alpha.md", contentHash: hash, kind: "fact", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: { state: "pending", token: "test-token" } }, () => {});
    expect(listEnrichmentWork(home, { vault: "mine", kind: "fact" }).items).toMatchObject([{ status: "needs-reconciliation" }]);
    const request = { vault: "mine", path: "alpha", kind: "fact" as const, resolution: "not_published" as const, channel: "mcp" as const }, preview = reconcileEnrichment(home, request);
    expect(preview).toMatchObject({ applied: false, warning: expect.stringContaining("duplicate") });
    expect(() => reconcileEnrichment(home, { ...request, confirm: true, fingerprint: "bad" })).toThrow(/stale/);
    expect(reconcileEnrichment(home, { ...request, confirm: true, fingerprint: preview.fingerprint })).toMatchObject({ applied: true, ok: true });
    expect(listEnrichmentWork(home, { vault: "mine", kind: "fact" }).items).toEqual([{ path: "notes/alpha.md", contentHash: hash }]);
    writeEnrichmentRecord(home, spec, { path: "notes/alpha.md", contentHash: hash, kind: "fact", producer: { skill: "fixture", version: "1", model: "test" }, createdAt: "2026-11-21T00:00:00.000Z", value: { state: "pending", token: "another-token" } }, () => {});
    const publishedRequest = { ...request, resolution: "published" as const }, publishedPreview = reconcileEnrichment(home, publishedRequest);
    expect(() => reconcileEnrichment(home, { ...publishedRequest, confirm: true, fingerprint: preview.fingerprint })).toThrow(/stale/);
    expect(reconcileEnrichment(home, { ...publishedRequest, confirm: true, fingerprint: publishedPreview.fingerprint })).toMatchObject({ ok: true, applied: true });
    expect(listEnrichmentWork(home, { vault: "mine", kind: "fact" }).items).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reconciliation refuses not_published when its intake ID exists in the journal", async () => {
  const { writeEnrichmentRecord } = await import("../src/enrichment-store.ts");
  const { reconcileEnrichment } = await import("../src/enrichment.ts");
  const { appendAssertions } = await import("../src/assertions.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-proof-")));
  try {
    const home = join(root, "home"), vault = join(root, "vault"), file = join(vault, "notes", "alpha.md");
    mkdirSync(join(vault, "notes"), { recursive: true });
    const source = "---\ntype: insight\ndescription: Fixture.\ndomain: research\n---\n# Alpha\n"; writeFileSync(file, source);
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const setting = { vault: "mine", changes: { enrichmentEnabled: true } }, p = changeSettings(home, setting);
    changeSettings(home, { ...setting, confirm: true, fingerprint: p.fingerprint });
    const spec = loadRegistry(home).vaults[0]!, hash = createHash("sha256").update(source).digest("hex"), token = "03000000-0000-4000-8000-000000000000", producer = { skill: "fixture", version: "1", model: "test" }, createdAt = "2026-11-21T00:00:00.000Z";
    writeEnrichmentRecord(home, spec, { path: "notes/alpha.md", contentHash: hash, kind: "fact", producer, createdAt, value: { state: "pending", token } }, () => {});
    const request = { vault: "mine", path: "alpha", kind: "fact" as const, resolution: "not_published" as const, channel: "mcp" as const }, preview = reconcileEnrichment(home, request);
    const receipt = appendAssertions(home, { vault: "mine", channel: "mcp", ops: [{ op: "declare", subject: "s:proof" }, { op: "assert", subject: "s:proof", relation: "state", value: "yes", kind: "state", from: "2026", to: "open", source: ["mem:fixture"] }] }, { origin: { path: "notes/alpha.md", sha256: hash, producer, createdAt, intakeId: token } });
    expect(receipt.applied).toBe(true);
    expect(() => reconcileEnrichment(home, { ...request, confirm: true, fingerprint: preview.fingerprint })).toThrow(/published to the journal/);
    expect(listEnrichmentWork(home, { vault: "mine", kind: "fact" }).items).toMatchObject([{ status: "needs-reconciliation" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reconciliation refuses not_published when its proposal ID exists", async () => {
  const { writeEnrichmentRecord } = await import("../src/enrichment-store.ts");
  const { reconcileEnrichment } = await import("../src/enrichment.ts");
  const { submitProposal } = await import("../src/proposal-provider.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-enrichment-proposal-proof-")));
  try {
    const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes"); mkdirSync(notes, { recursive: true });
    const source = "---\ntype: insight\ndescription: Fixture.\ndomain: research\ntopics: ['[[research]]']\n---\n# Alpha\n\n## Topics\n\n- [[research]]\n";
    writeFileSync(join(notes, "alpha.md"), source); writeFileSync(join(notes, "beta.md"), source); writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Research.\n---\n# Research\n");
    addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp" });
    const setting = { vault: "mine", changes: { enrichmentEnabled: true } }, p = changeSettings(home, setting);
    changeSettings(home, { ...setting, confirm: true, fingerprint: p.fingerprint });
    const spec = loadRegistry(home).vaults[0]!, hash = createHash("sha256").update(source).digest("hex"), token = "04000000-0000-4000-8000-000000000000", producer = { skill: "fixture", version: "1", model: "test" }, createdAt = "2026-11-21T00:00:00.000Z";
    writeEnrichmentRecord(home, spec, { path: "notes/alpha.md", contentHash: hash, kind: "inferred-link", producer, createdAt, value: { state: "pending", token } }, () => {});
    const request = { vault: "mine", path: "alpha", kind: "inferred-link" as const, resolution: "not_published" as const, channel: "mcp" as const }, preview = reconcileEnrichment(home, request);
    const proposal = submitProposal(home, { vault: "mine", operation: { op: "patch", path: "alpha", expectedSha: hash, edits: [{ oldString: "## Topics", newString: "- [[beta]] <!-- vmem:inferred -->\n\n## Topics" }] }, agentLabel: `enrichment:${token}` }, { channel: "mcp", proposalId: token });
    expect(proposal.stored).toBe(true);
    expect(() => reconcileEnrichment(home, { ...request, confirm: true, fingerprint: preview.fingerprint })).toThrow(/proposal was published/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
