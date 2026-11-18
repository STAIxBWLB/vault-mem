import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, loadRegistry } from "../src/registry.ts";
import { CONFIG_FILE } from "../src/config.ts";
import { evidenceProblem, evidenceReport, screenEvidenceForTarget } from "../src/evidence.ts";
import { run } from "../src/cli.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import { applyWrite } from "../src/writer.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const SOURCE = "---\ndescription: Synthetic source.\ntype: reference\n---\n# Source\n\n## 개요\n\n한국어 인용 😀 문장.\n\n## Repeat\n\nsame same\n\n## Dup\n\na\n\n## Dup\n\nb\n";
const MOC = "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n";

/** Isolated home and vault inside a workspace root (workspace.config.yaml + project registry). */
function fixture(options: { registry?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-evidence-"))); roots.push(root);
  const home = join(root, "state"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(root, "workspace.config.yaml"), "name: fixture\n");
  writeFileSync(join(root, "projects.yaml"), "projects: []\n");
  writeFileSync(join(notes, "research.md"), MOC);
  writeFileSync(join(notes, "src-note.md"), SOURCE);
  addVault(home, { id: "mine", path: vault, kind: "personal", write: "mcp", ...(options.registry === false ? {} : { registry: join(root, "projects.yaml") }) });
  const cite = (stem: string, entries: unknown[], source: unknown = ["vault/notes/src-note.md", "https://example.invalid/a", "mem:abc"]) => {
    writeFileSync(join(notes, `${stem}.md`), `---\ndescription: Citing note.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\nsource: ${JSON.stringify(source)}\nevidence: ${JSON.stringify(entries)}\n---\n# ${stem}\n\nBody.\n\n## Topics\n\n- [[research]]\n`);
  };
  const vaultSpec = () => loadRegistry(home).vaults.find(v => v.id === "mine")!;
  const env = { HOME: root, VMEM_HOME: home, AGENTHUB_HOME: join(root, "family"), AMEM_HOME: join(root, "memory"), PATH: process.env.PATH };
  return { root, home, vault, notes, cite, vaultSpec, env };
}
const entry = (quote: string, extra: Record<string, unknown> = {}) => ({ source: "vault/notes/src-note.md", sha256: sha(SOURCE), quote, ...extra });

test("E1 Korean/emoji quote verifies with exact UTF-8 byte offsets and the source SHA", () => {
  const f = fixture(), quote = "인용 😀 문장";
  f.cite("c", [entry(quote), entry(quote, { section: "개요" })]);
  const report = evidenceReport(f.vaultSpec(), "c");
  const start = Buffer.from(SOURCE).indexOf(Buffer.from(quote));
  expect(report.schemaVersion).toBe(1);
  expect(report.note.path).toBe("notes/c.md");
  expect(report.truncated).toBe(false);
  for (const result of report.evidence) {
    expect(result.status).toBe("verified");
    expect(result.observedSha256).toBe(sha(SOURCE));
    expect(result.match).toEqual({ start, end: start + Buffer.byteLength(quote) });
  }
  expect(JSON.stringify(report)).not.toContain(quote);
});

test("E1 duplicates, missing/duplicate H2, unresolved root and externals have distinct outcomes", () => {
  const f = fixture();
  f.cite("c", [entry("same"), entry("x", { section: "Nope" }), entry("a", { section: "Dup" }), entry("absent"),
    { source: "https://example.invalid/a", sha256: sha("x"), quote: "q" }, { source: "mem:abc", sha256: sha("x"), quote: "q" }]);
  const statuses = evidenceReport(f.vaultSpec(), "c").evidence.map(r => [r.status, r.reason]);
  expect(statuses).toEqual([["ambiguous", "quote_ambiguous"], ["missing", "section_not_found"], ["ambiguous", "section_ambiguous"], ["missing", "quote_not_found"],
    ["unverified_external", "external_reference"], ["unverified_external", "external_reference"]]);
  const standalone = fixture({ registry: false });
  standalone.cite("c", [entry("인용")]);
  expect(evidenceReport(standalone.vaultSpec(), "c").evidence[0]).toMatchObject({ status: "unsupported", reason: "unresolved_source_root" });
});

test("E1 malformed metadata is reported by schema validation and as unsupported", () => {
  expect(evidenceProblem([{ source: "a.md", sha256: "ABC", quote: "q" }], "a.md")).toContain("sha256");
  expect(evidenceProblem([{ source: "a.md", sha256: sha("x"), quote: "q" }], "b.md")).toContain("also be listed");
  expect(evidenceProblem([{ source: "a.md", sha256: sha("x"), quote: "x".repeat(2049) }], "a.md")).toContain("quote");
  expect(evidenceProblem(Array.from({ length: 17 }, () => ({ source: "a.md", sha256: sha("x"), quote: "q" })), "a.md")).toContain("1..16");
  expect(evidenceProblem([{ source: "a.md", sha256: sha("x"), quote: "q", extra: 1 }], "a.md")).toContain("unknown key");
  expect(evidenceProblem([{ source: "a.md", sha256: sha("x"), quote: "q", section: "S" }], "a.md")).toBeUndefined();
  expect(evidenceProblem([{ source: "a.md", sha256: sha("x"), quote: "\ud83d" }], "a.md")).toContain("well-formed");
  expect(evidenceProblem([{ source: "a.md", sha256: sha("x"), quote: "q", section: "\ude00" }], "a.md")).toContain("well-formed");
  const f = fixture();
  f.cite("c", [{ source: "vault/notes/src-note.md", sha256: "bad", quote: "q" }, entry("\ud83d")]);
  const results = evidenceReport(f.vaultSpec(), "c").evidence;
  expect(results[0]).toMatchObject({ status: "unsupported", reason: "invalid_metadata" });
  // An escaped lone surrogate would match half of the source emoji in UTF-16; it must never verify.
  expect(results[1]).toMatchObject({ status: "unsupported", reason: "invalid_metadata" });
  expect(results[1]!.match).toBeUndefined();
});

test("E2 editing, moving or deleting the cited source never leaves verified, and every call recomputes", () => {
  const f = fixture();
  f.cite("c", [entry("인용 😀 문장")]);
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]!.status).toBe("verified");
  writeFileSync(join(f.notes, "src-note.md"), SOURCE + "\nedit\n");
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]).toMatchObject({ status: "stale", reason: "sha_mismatch" });
  writeFileSync(join(f.notes, "src-note.md"), SOURCE);
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]!.status).toBe("verified");
  renameSync(join(f.notes, "src-note.md"), join(f.notes, "moved.md"));
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]).toMatchObject({ status: "missing", reason: "source_not_found" });
  rmSync(join(f.notes, "moved.md"));
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]!.status).toBe("missing");
});

test("E2 symlink escapes, other vaults, nested paths, denied paths and invalid UTF-8 are not verified", () => {
  const f = fixture(), outside = join(f.root, "outside.md");
  writeFileSync(outside, SOURCE);
  symlinkSync(outside, join(f.notes, "link.md"));
  mkdirSync(join(f.root, "other", "notes"), { recursive: true }); writeFileSync(join(f.root, "other", "notes", "x.md"), SOURCE);
  mkdirSync(join(f.notes, "sub")); writeFileSync(join(f.notes, "sub", "n.md"), SOURCE);
  writeFileSync(join(f.notes, "bad.md"), Buffer.from([0xff, 0xfe, 0x41]));
  const sources = ["vault/notes/link.md", "other/notes/x.md", "vault/notes/sub/n.md", "outside.md", "vault/notes/bad.md"];
  f.cite("c", sources.map(source => ({ source, sha256: sha(SOURCE), quote: "인용" })), sources);
  const results = evidenceReport(f.vaultSpec(), "c").evidence;
  expect(results.map(r => r.reason)).toEqual(["outside_vault", "outside_vault", "outside_vault", "outside_vault", "invalid_utf8"]);
  expect(results.every(r => r.status === "unsupported")).toBe(true);
  const denied = evidenceReport(f.vaultSpec(), "c", [join(f.notes, "bad.md")]).evidence[4]!;
  expect(denied.reason).toBe("denied");
});

test("E2 registry changes rebind the source root on every call", () => {
  const f = fixture();
  f.cite("c", [entry("인용")]);
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]!.status).toBe("verified");
  const configFile = join(f.home, CONFIG_FILE), config = JSON.parse(readFileSync(configFile, "utf8"));
  delete config.vaults[0].registry; writeFileSync(configFile, JSON.stringify(config));
  expect(evidenceReport(f.vaultSpec(), "c").evidence[0]!.reason).toBe("unresolved_source_root");
});

test("E3 legacy notes without evidence stay valid; writes block new malformed evidence but not source drift", () => {
  const f = fixture();
  const legacy = applyWrite(f.home, { vault: "mine", channel: "cli", operation: { op: "create", path: "legacy", frontmatter: { type: "insight", domain: "research", description: "A legacy note.", topics: ["[[research]]"], source: "vault/notes/src-note.md" } } });
  expect(legacy.ok).toBe(true);
  expect(evidenceReport(f.vaultSpec(), "legacy").evidence).toEqual([]);
  const bad = applyWrite(f.home, { vault: "mine", channel: "cli", operation: { op: "frontmatter", path: "legacy", set: { evidence: [{ source: "vault/notes/src-note.md", sha256: "nope", quote: "q" }] } } });
  expect(bad.ok).toBe(false);
  expect(bad.issues.some(i => i.code === "V01" && i.message.includes("sha256"))).toBe(true);
  const good = applyWrite(f.home, { vault: "mine", channel: "cli", operation: { op: "frontmatter", path: "legacy", set: { evidence: [entry("인용")] } } });
  expect(good.ok).toBe(true);
  writeFileSync(join(f.notes, "src-note.md"), SOURCE + "drift\n");
  const unrelated = applyWrite(f.home, { vault: "mine", channel: "cli", operation: { op: "patch", path: "legacy", oldString: "# legacy", newString: "# Legacy" } });
  expect(unrelated.issues.filter(i => i.severity === "error")).toEqual([]);
  const report = lintVault(analysisInput(f.home, "mine").snapshot);
  expect(report.findings.L16).toEqual(["`notes/legacy.md`: evidence[0] stale (sha_mismatch)"]);
  expect(report.markdown).not.toContain("인용");
});

test("E3 org promotion keeps destination-resolvable and URL evidence and reports removals without paths or quotes", () => {
  const f = fixture();
  const org = join(f.root, "org"); mkdirSync(join(org, "notes"), { recursive: true }); writeFileSync(join(org, "notes", "research.md"), MOC); writeFileSync(join(org, "notes", "src-note.md"), SOURCE);
  addVault(f.home, { id: "team", path: org, kind: "org", write: "cli", registry: join(f.root, "projects.yaml") });
  const team = loadRegistry(f.home).vaults.find(v => v.id === "team")!;
  const sources = ["vault/notes/src-note.md", "org/notes/src-note.md", "https://example.invalid/a", "mem:abc"];
  const entries = sources.map(source => ({ source, sha256: sha(SOURCE), quote: "SECRET_QUOTE_" + source.length }));
  const screened = screenEvidenceForTarget(entries, sources, team);
  expect(screened.kept!.map(e => e.source)).toEqual(["org/notes/src-note.md", "https://example.invalid/a"]);
  expect(screened.removed).toEqual([{ index: 0, reason: "not_in_destination" }, { index: 3, reason: "memory_not_retained" }]);
  expect(JSON.stringify(screened.removed)).not.toMatch(/vault\/notes|SECRET_QUOTE|mem:/);
});

test("E4 CLI JSON and MCP share the versioned shape; reads are annotated read-only and write nothing", async () => {
  const f = fixture();
  f.cite("c", [entry("인용 😀 문장"), { source: "https://example.invalid/a", sha256: sha("x"), quote: "q" }]);
  const before = readdirSync(f.vault, { recursive: true }).sort(), hadState = existsSync(join(f.home, "index"));
  const cli = await run(["evidence", "mine", "c", "--json"], f.env);
  expect(cli.code).toBe(0);
  const mcp = createVaultMcp(f.home, f.env);
  const tool = mcp.tools.find(t => t.name === "vmem_evidence")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  const fromMcp = await mcp.handlers.vmem_evidence!({ vault: "mine", path: "c" });
  expect(JSON.parse(cli.text)).toEqual(fromMcp);
  expect((fromMcp as { evidence: unknown[] }).evidence).toHaveLength(2);
  const human = await run(["evidence", "mine", "c"], f.env);
  expect(human.text).toContain("verified");
  expect(human.text).not.toContain("인용 😀");
  expect(readdirSync(f.vault, { recursive: true }).sort()).toEqual(before);
  expect(existsSync(join(f.home, "index"))).toBe(hadState);
  expect(await mcp.handlers.vmem_evidence!({ vault: "mine", path: "../x" })).toMatchObject({ refused: true });
  const unknown = await mcp.handlers.vmem_evidence!({ vault: "mine", path: "nope" }) as { issues: { message: string }[] };
  expect(unknown.issues[0]!.message).toContain("vmem search mine");
});

test("E3 org promotion preview drops non-retained evidence from the transformed note", async () => {
  const { promoteToOrg } = await import("../src/org-promote.ts");
  const f = fixture();
  const org = join(f.root, "org"); mkdirSync(join(org, "notes"), { recursive: true }); writeFileSync(join(org, "notes", "research.md"), MOC);
  addVault(f.home, { id: "team", path: org, kind: "org", write: "cli", registry: join(f.root, "projects.yaml") });
  f.cite("c", [{ ...entry("PRIVATE_QUOTE_MARKER"), source: "vault/notes/src-note.md" }, { source: "https://example.invalid/a", sha256: sha("x"), quote: "public" }]);
  const preview = promoteToOrg(f.home, { from: "mine", note: "c", to: "team" }, { env: f.env });
  expect(preview.evidenceRemoved).toEqual([{ index: 0, reason: "not_in_destination" }]);
  expect(preview.text).toBeDefined();
  expect(preview.text).not.toContain("PRIVATE_QUOTE_MARKER");
  expect(preview.text).toContain("https://example.invalid/a");
});
