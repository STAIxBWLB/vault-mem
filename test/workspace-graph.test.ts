import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AnalysisSnapshot } from "../src/analysis-types.ts";
import type { VaultSpec, VmemConfig } from "../src/config.ts";
import { buildWorkspaceGraph, type WorkspaceSnapshot } from "../src/workspace-graph.ts";
import { WORK_MAX_FILES, workspaceInput } from "../src/workspace-input.ts";
import { addVault } from "../src/registry.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { writeAnalysisReports } from "../src/analysis-reports.ts";
import { run } from "../src/cli.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const document = (fm: string, body = "Synthetic body.") => `---\n${fm}\n---\n${body}\n`;
function snapshot(): AnalysisSnapshot {
  const note = (id: string, fm = "", body = "") => ({ path: `${id}.md`, source: document(`type: ${id === "h" ? "moc" : "insight"}\ndescription: Synthetic vault node.\n${fm}`, body) });
  return {
    today: "2026-10-31", logPath: "/synthetic/log", log: null, registryIds: null, reports: {},
    notes: [
      note("a", 'source: "work/projects/source.md"\nsupersedes: "[[h]]"', "[[h]]"),
      note("b", "source: plain-stub"), note("c", "source: inbox/hidden.md"),
      note("d", "source: dead.md"), note("e", "source: folder"),
      note("f", "source: picture.pdf"), note("g", "source: scratchpad/memos/memo.md"),
      note("h", "source: https://example.invalid/document.md"), note("i", "source: work/projects/source.md"),
    ],
  };
}
function work(): WorkspaceSnapshot {
  return {
    buSlugs: ["unit", "unused"], skipRoots: ["scratchpad/memos", "scratchpad/temp"],
    sourceTargets: { "plain-stub": "file", dead: "missing", folder: "directory" },
    files: [
      { path: "projects/source.md", text: document(`document_type: decision
projects: ["[[a]]"]
attendees: ["[[h]]"]
business_unit: "[[unit]]"
related:
  - {doc: "target.md (parent decision)", rel: supports}
  - {doc: target.md, rel: alternate}
  - "[[unique target]]"
  - "[[missing]]"
  - "[[shared]]"
  - "~/private.md"
  - "../../escape.md"
  - "dir/"
  - plain.txt
  - missing.md
  - ./source.md`, "[[a]] [[h]] [[b]] [[b]]") },
      { path: "projects/target.md", text: document("document_type: memo") },
      { path: "docs/unique-target.md", text: document("document_type: reference") },
      { path: "one/shared.md", text: document("document_type: memo") },
      { path: "two/shared.md", text: document("document_type: memo") },
      { path: "docs/README.md", text: document('projects: ["[[h]]"]') },
      { path: "docs/date.md", text: document("document_type: 2026-08-19\ntitle: 2026-08-19") },
      { path: "invalid.md", text: document("document_type: [") },
      { path: "template.md", text: document('document_type: "{{ type }}"') },
      { path: "plain.md", text: "No frontmatter here.\n" },
      { path: "nonqualifying.md", text: document("title: Does not qualify") },
    ],
  };
}
const edgeSet = (edges: { source: string; target: string; relation: string; field?: string; rel?: string }[]) => edges.map(edge => ({
  pair: [edge.source, edge.target].sort().join("|"), relation: edge.relation,
  ...(edge.field === undefined ? {} : { field: edge.field }), ...(edge.rel === undefined ? {} : { rel: edge.rel }),
})).sort((a, b) => a.pair.localeCompare(b.pair));

test("workspace extraction preserves exact node kinds, relations, precedence and diagnostic counters", () => {
  const result = buildWorkspaceGraph(snapshot(), work());
  expect(result.graph.nodes.map(n => n.id).sort()).toEqual([
    "a", "b", "bu:unit", "c", "d", "e", "f", "g", "h", "i",
    "work:docs/README", "work:docs/date", "work:docs/unique-target", "work:one/shared", "work:plain-stub",
    "work:projects/source", "work:projects/target", "work:two/shared",
  ].sort());
  expect(edgeSet(result.graph.edges)).toEqual(edgeSet([
    { source: "a", target: "h", relation: "supersedes", field: "supersedes" },
    { source: "a", target: "work:projects/source", relation: "source_ref" },
    { source: "i", target: "work:projects/source", relation: "source_ref" },
    { source: "b", target: "work:plain-stub", relation: "source_ref" },
    { source: "b", target: "work:projects/source", relation: "wiki_link" },
    { source: "h", target: "work:projects/source", relation: "fm_ref", field: "attendees" },
    { source: "work:projects/source", target: "work:projects/target", relation: "related", rel: "supports" },
    { source: "work:projects/source", target: "work:docs/unique-target", relation: "related" },
    { source: "bu:unit", target: "work:projects/source", relation: "bu_member" },
    { source: "h", target: "work:docs/README", relation: "fm_ref", field: "projects" },
  ]));
  expect(result.counters).toEqual({
    work_docs: 7, yaml_fail: 1, template_skip: 1,
    related_unresolved: 2, related_ambiguous: 1, related_dir_skip: 2,
    related_root_escape: 1, related_home_escape: 1,
    source_stub: 1, source_dead: 1, source_nonmd: 2, source_skiproot: 2,
    collisions: 3, dup_edges: 2,
  });
  expect(result.relations).toEqual({ wiki_link: 1, fm_ref: 2, bu_member: 1, source_ref: 3, related: 2, supersedes: 1 });
  expect(result.graph.nodes.find(n => n.id === "work:docs/README")).toMatchObject({ label: "Docs Readme", type: "work-doc", domain: "docs", source_file: "docs/README.md" });
  expect(result.graph.nodes.find(n => n.id === "work:docs/date")).toMatchObject({ type: "2026-08-19", description: "2026-08-19" });
  expect(result.graph.nodes.find(n => n.id === "work:plain-stub")).toMatchObject({ type: "file", source_file: "plain-stub.md" });
  expect(result.graph.nodes.find(n => n.id === "bu:unit")?.community).toBeNull();
  expect(result.graph.nodes.find(n => n.id === "h")?.community).toBeNull();
  expect(result.graph.edges.every(e => e.source !== e.target && e.confidence_tag === "EXTRACTED" && e.confidence === 1)).toBe(true);
});

test("workspace labels, scalar metadata and wiki targets follow Python and NFC rules", () => {
  const input = snapshot();
  input.notes = [
    { path: "a.md", source: document('type: insight\nsuperseded_by: "[[b]]"', "[[b]]") },
    { path: "b.md", source: document("type: moc") },
  ];
  const result = buildWorkspaceGraph(input, {
    files: [
      { path: "docs/é.md", text: document('document_type: [memo, decision]\ntitle: "' + "😀".repeat(201) + '"') },
      { path: "docs/Index.md", text: document('related: "[[é]]"') },
    ], buSlugs: [], skipRoots: [], sourceTargets: {},
  });
  expect(result.graph.nodes.find(n => n.id === "work:docs/é")).toMatchObject({ label: "É", type: "['memo', 'decision']", description: "😀".repeat(200) });
  expect(result.graph.nodes.find(n => n.id === "work:docs/Index")?.label).toBe("Docs Index");
  expect(edgeSet(result.graph.edges)).toEqual(edgeSet([
    { source: "a", target: "b", relation: "supersedes", field: "superseded_by" },
    { source: "work:docs/Index", target: "work:docs/é", relation: "related" },
  ]));
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-workspace-"))); roots.push(root);
  const workRoot = join(root, "work"), vault = join(workRoot, "vault"), home = join(root, "state");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "a.md"), document("type: moc\ndescription: Synthetic graph fixture."));
  const registry = join(workRoot, "project-registry.yaml"); writeFileSync(registry, "projects: []\n");
  const spec: VaultSpec = { id: "test", path: vault, kind: "personal", write: "mcp", registry };
  addVault(home, spec);
  const put = (path: string, text = document("document_type: memo")) => { const file = join(workRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  const config: VmemConfig = { vaults: [spec] };
  return { root, workRoot, vault, home, spec, config, put, env: { VMEM_HOME: home } };
}
function disk(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name), rel = prefix + entry.name;
      if (entry.isDirectory()) walk(file, rel + "/");
      else if (entry.isFile()) out[rel] = readFileSync(file).toString("base64");
    }
  };
  walk(root, ""); return out;
}

test("workspace reader prunes reference directories, scratchpad roots, symlinks and denied paths", () => {
  const f = fixture();
  const skipped = [".git", "node_modules", ".venv", ".sync-conflicts", "temp", ".maru", ".pnpm-store", ".conductor", ".dotfiles", ".omx", ".omc", ".gstack", ".frontend-slides", ".claude", ".archive", "archive", "inbox", "sites", "dev", "shared", "_templates", "templates"];
  for (const dir of skipped) f.put(`${dir}/skipped.md`);
  f.put("scratchpad/memos/skipped.md"); f.put("scratchpad/temp/skipped.md");
  f.put("scratchpad/ideas/keep.md"); f.put("projects/keep.md"); f.put("projects/denied.md");
  f.config.denyPaths = ["denied.md"];
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "linked.md"), document("document_type: memo"));
  symlinkSync(outside, join(f.workRoot, "linked-dir")); symlinkSync(join(outside, "linked.md"), join(f.workRoot, "linked-file.md"));
  f.put(".maru/units/real/bu-config.yaml", "bu_id: fixture-unit\n");
  f.put("archive/ignored/bu-config.yaml", "bu_id: archived-unit\n");
  f.put(".maru/units/invalid/bu-config.yaml", "bu_id: Invalid_Unit\n");
  const probe = snapshot();
  probe.notes = [
    { path: "a.md", source: document("source: projects/denied.md") },
    { path: "b.md", source: document("source: linked-file.md") },
    { path: "c.md", source: document("source: ../outside/linked.md") },
    { path: "d.md", source: document("source: projects/keep.md") },
  ];
  const captured = workspaceInput(probe, f.spec, f.config);
  expect(captured.sourceTargets).toMatchObject({ "projects/denied": "denied", "linked-file": "missing", "../outside/linked": "missing", "projects/keep": "file" });
  expect(captured.files.map(file => file.path).sort()).toEqual(["projects/keep.md", "scratchpad/ideas/keep.md"]);
  expect(captured.buSlugs).toEqual(["fixture-unit"]);
  expect(captured.skipRoots.sort()).toEqual(["scratchpad/memos", "scratchpad/temp"]);
  expect(() => workspaceInput(snapshot(), { ...f.spec, registry: undefined }, f.config)).toThrow();
});

test("workspace reader honors configured scratchpad roots and rejects oversized work files", () => {
  const f = fixture();
  f.put("workspace.config.yaml", `paths:\n  scratchpad: ${join(f.workRoot, "drafts")}\nscratchpad:\n  memos_subdir: journal\n  temp_subdir: ephemeral\n`);
  f.put("drafts/journal/skipped.md"); f.put("drafts/ephemeral/skipped.md"); f.put("drafts/ideas/keep.md");
  f.put("scratchpad/memos/now-visible.md");
  const captured = workspaceInput(snapshot(), f.spec, f.config);
  expect(captured.files.map(file => file.path).sort()).toEqual(["drafts/ideas/keep.md", "scratchpad/memos/now-visible.md"]);
  expect(captured.skipRoots.sort()).toEqual(["drafts/ephemeral", "drafts/journal"]);
  f.put("projects/too-large.md", document("document_type: memo", "x".repeat(2 * 1024 * 1024 + 1)));
  expect(() => workspaceInput(snapshot(), f.spec, f.config)).toThrow("exceeds bound");
});

test("workspace reader enforces aggregate byte and file-count bounds", () => {
  const bytes = fixture();
  const source = document("document_type: memo", "x".repeat(2 * 1024 * 1024 - 64));
  for (let i = 0; i < 65; i++) bytes.put(`docs/file-${i}.md`, source);
  expect(() => workspaceInput(snapshot(), bytes.spec, bytes.config)).toThrow("total bytes");
  const count = fixture();
  for (let i = 0; i < WORK_MAX_FILES + 1; i++) count.put(`docs/file-${i}.md`, "plain\n");
  expect(() => workspaceInput(snapshot(), count.spec, count.config)).toThrow("file count");
}, 120_000);

test("each work file counts once toward the file bound, frontmatter or not", () => {
  const f = fixture();
  for (let i = 0; i < WORK_MAX_FILES / 2 + 1; i++) f.put(`docs/file-${i}.md`, document("title: small"));
  expect(() => workspaceInput(snapshot(), f.spec, f.config)).not.toThrow();
}, 120_000);

test("a plain work file that gains frontmatter after the probe fails the change check", () => {
  const f = fixture();
  const file = f.put("docs/doc.md", "plain text\n");
  const captured = workspaceInput(snapshot(), f.spec, f.config);
  expect(captured.files).toEqual([]);
  writeFileSync(file, document("document_type: memo"));
  expect(() => captured.assertUnchanged!()).toThrow("changed");
});

test("files without frontmatter are probed, never read, so their size does not count", () => {
  const f = fixture();
  f.put("docs/huge-plain.md", "# Plain\n" + "x".repeat(3 * 1024 * 1024));
  f.put("docs/dashes.md", "---no frontmatter\n");
  f.put("docs/short.md", "---");
  f.put("docs/keep.md");
  f.put("docs/crlf.md", "---\r\ndocument_type: memo\r\n---\r\nBody\r\n");
  const captured = workspaceInput(snapshot(), f.spec, f.config);
  expect(captured.files.map(file => file.path).sort()).toEqual(["docs/crlf.md", "docs/keep.md"]);
  f.put("docs/huge-front.md", document("document_type: memo", "x".repeat(2 * 1024 * 1024)));
  expect(() => workspaceInput(snapshot(), f.spec, f.config)).toThrow();
});

test("workspace build dry-run is read-only and writes only workspace graph plus one GRAPH event", async () => {
  const f = fixture(); f.put("projects/keep.md", document('document_type: memo\nprojects: ["[[a]]"]'));
  const before = disk(f.root);
  const dry = writeAnalysisReports(f.home, { vault: "test", kind: "graph", workspace: true, dryRun: true, today: "2026-10-31" });
  expect(dry.ok).toBe(true); expect(dry.applied).toBe(false); expect(disk(f.root)).toEqual(before);
  const cli = run(["graph", "build", "test", "--workspace", "--dry-run", "--json"], f.env);
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text).paths).toEqual(["reports/workspace-graph.json"]);
  expect(disk(f.root)).toEqual(before);
  expect(() => run(["lint", "test", "--workspace"], f.env)).toThrow();
  expect(() => run(["graph", "neighbors", "test", "a", "--workspace"], f.env)).toThrow();
  const server = createVaultMcp(f.home, f.env);
  const mcpDry = await server.handlers.vmem_graph_build!({ vault: "test", workspace: true, dryRun: true }) as { ok: boolean; paths: string[] };
  expect(mcpDry.ok).toBe(true); expect(mcpDry.paths).toEqual(["reports/workspace-graph.json"]); expect(disk(f.root)).toEqual(before);
  const result = writeAnalysisReports(f.home, { vault: "test", kind: "graph", workspace: true, today: "2026-10-31" });
  expect(result.ok).toBe(true); expect(result.applied).toBe(true); expect(result.paths).toEqual(["reports/workspace-graph.json"]);
  expect(readdirSync(join(f.vault, "reports"))).toEqual(["workspace-graph.json"]);
  const graph = JSON.parse(readFileSync(join(f.vault, "reports", "workspace-graph.json"), "utf8"));
  expect(graph.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["a", "work:projects/keep"]);
  const lines = readFileSync(join(f.vault, "log"), "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(1); expect(lines[0]).toContain("  GRAPH  "); expect(lines[0]).toContain("reports/workspace-graph.json");
  expect(existsSync(join(f.vault, "reports", "vault-graph.json"))).toBe(false);
  expect(analysisInput(f.home, "test").snapshot.notes).toHaveLength(1);
});
