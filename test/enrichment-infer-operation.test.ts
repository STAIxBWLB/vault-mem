import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { parseProposalOperation } from "../src/proposals.ts";
import { submitProposal, previewProposalApply, applyProposal } from "../src/proposal-provider.ts";
import { addVault } from "../src/registry.ts";
import { sha256 } from "../src/writer.ts";
import { planOperation, planMerge } from "../src/write-operations.ts";
import { buildGraph } from "../src/vault-graph.ts";

const source = "---\ntype: insight\ndomain: research\ndescription: Synthetic note.\ntopics:\n  - '[[research]]'\n---\n# Source\n\nSynthetic text.\n\n## Topics\n\n- [[research]]\n";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-infer-op-"))), home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "source.md"), source);
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n");
  writeFileSync(join(notes, "target.md"), "---\ntype: insight\ndomain: research\ndescription: Synthetic target.\ntopics: ['[[research]]']\n---\n# Target\n\nSynthetic.\n\n## Topics\n\n- [[research]]\n");
  addVault(home, { id: "test", path: vault, kind: "personal", write: "mcp" });
  return { root, home, notes, operation: { op: "infer-link", path: "source", target: "target", expectedSha: sha256(source) } };
}
test("inferred link proposal atomically adds a plain body link and target metadata", () => {
  const f = fixture();
  try {
    expect(parseProposalOperation(f.operation)).toEqual({ ...f.operation, path: "notes/source.md" });
    const submitted = submitProposal(f.home, { vault: "test", operation: f.operation }, { channel: "mcp" });
    const preview = previewProposalApply(f.home, { vault: "test", id: submitted.id }, { channel: "mcp" });
    expect(preview.issues.filter(i => i.severity === "error")).toEqual([]);
    expect(applyProposal(f.home, { vault: "test", id: submitted.id, fingerprint: preview.fingerprint }, { channel: "mcp" }).applied).toBe(true);
    const after = readFileSync(join(f.notes, "source.md"), "utf8");
    expect(parseFrontmatter(after).data.inferred_links).toEqual(["target"]);
    expect(after).toContain("- [[target]]"); expect(after.indexOf("- [[target]]")).toBeLessThan(after.indexOf("## Topics"));
    expect(after).toContain("topics:\n  - '[[research]]'");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("missing target, duplicate and stale source are refused", () => {
  const f = fixture();
  try {
    const preview = (operation: unknown) => { const p = submitProposal(f.home, { vault: "test", operation }, { channel: "mcp" }); return previewProposalApply(f.home, { vault: "test", id: p.id }, { channel: "mcp" }); };
    expect(() => preview({ ...f.operation, target: "missing" })).toThrow();
    writeFileSync(join(f.notes, "source.md"), source + "\nchanged\n");
    expect(() => preview(f.operation)).toThrow();
    const linked = source.replace("Synthetic text.", "Synthetic text with [[target]].");
    writeFileSync(join(f.notes, "source.md"), linked);
    expect(() => preview({ ...f.operation, expectedSha: sha256(linked) })).toThrow();
    expect(() => parseProposalOperation({ ...f.operation, extra: true })).toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("repairs an inferred_links entry missing its visible body link", () => {
  const f = fixture();
  try {
    const existing = source.replace("description: Synthetic note.\n", "description: Synthetic note.\ninferred_links:\n  - target\n");
    writeFileSync(join(f.notes, "source.md"), existing);
    const proposal = submitProposal(f.home, { vault: "test", operation: { ...f.operation, expectedSha: sha256(existing) } }, { channel: "mcp" });
    const preview = previewProposalApply(f.home, { vault: "test", id: proposal.id }, { channel: "mcp" });
    expect(applyProposal(f.home, { vault: "test", id: proposal.id, fingerprint: preview.fingerprint }, { channel: "mcp" }).applied).toBe(true);
    const after = readFileSync(join(f.notes, "source.md"), "utf8");
    expect(after).toContain("inferred_links:\n  - target\n");
    expect(after.match(/\[\[target\]\]/g)).toHaveLength(1);
    expect(after.indexOf("[[target]]")).toBeLessThan(after.indexOf("## Topics"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const synthetic = (title: string, body = "", links: string[] = []) => `---\ntype: insight\ndomain: research\ndescription: Synthetic note.\ntopics: []\ninferred_links: ${JSON.stringify(links)}\n---\n# ${title}\n\n${body}\n\n## Topics\n`;
const afterOf = (changes: ReturnType<typeof planOperation>, path: string, fallback: string) => changes.find(change => change.path === path)?.after ?? fallback;
test("move rewrites inferred target stems and body links together", () => {
  const notes = new Map([["notes/old.md", synthetic("Old", "[[old]]", ["old"])], ["notes/a.md", synthetic("A", "[[old]]", ["old"])] ]);
  const changes = planOperation({ op: "move", from: "old", to: "new" }, notes);
  for (const path of ["notes/new.md", "notes/a.md"]) {
    const changed = changes.find(c => c.path === path)!.after!;
    expect(parseFrontmatter(changed).data.inferred_links).toEqual(["new"]);
    expect(changed).toContain("[[new]]");
  }
  const a = afterOf(changes, "notes/a.md", notes.get("notes/a.md")!), b = changes.find(c => c.path === "notes/new.md")!.after!;
  const graph = buildGraph({ notes: [{ path: "a.md", source: a }, { path: "new.md", source: b }], today: "", logPath: "", log: null, registryIds: null, reports: {} });
  expect(graph.edges.find(edge => edge.source === "a" && edge.target === "new")?.confidence_tag).toBe("INFERRED");
});

test("merge preserves witnessed absorbed declarations and rewrites inbound stems", () => {
  const notes = new Map([["notes/keep.md", synthetic("Keep", "[[target]]", ["target"])], ["notes/absorb.md", synthetic("Absorb", "[[target]] [[other]]", ["target", "other", "orphan"])], ["notes/target.md", synthetic("Target")], ["notes/other.md", synthetic("Other")], ["notes/inbound.md", synthetic("Inbound", "[[absorb]]", ["absorb"])]]);
  const changes = planMerge({ op: "merge", keep: "keep", absorb: "absorb" }, notes).changes;
  const keep = changes.find(c => c.path === "notes/keep.md")!.after!, inbound = changes.find(c => c.path === "notes/inbound.md")!.after!;
  expect(parseFrontmatter(keep).data.inferred_links).toEqual(["target", "other"]);
  expect(parseFrontmatter(inbound).data.inferred_links).toEqual(["keep"]);
  expect(inbound).toContain("[[keep]]");
});

test("move and merge refuse orphan declarations that would attach to another link", () => {
  const moving = new Map([["notes/old.md", synthetic("Old")], ["notes/a.md", synthetic("A", "[[old]]", ["new"])]]);
  expect(() => planOperation({ op: "move", from: "old", to: "new" }, moving)).toThrow("orphan inferred_links");
  const merging = new Map([["notes/keep.md", synthetic("Keep", "", ["target"])], ["notes/absorb.md", synthetic("Absorb", "[[target]]")], ["notes/target.md", synthetic("Target")]]);
  expect(() => planMerge({ op: "merge", keep: "keep", absorb: "absorb" }, merging)).toThrow("orphan inferred_links");
});

test("merge preserves absorbed inference witnessed by a reassembled Topics link", () => {
  const absorbed = synthetic("Absorb", "", ["research"]).replace("topics: []", "topics: ['[[research]]']").replace("## Topics\n", "## Topics\n- [[research]]\n");
  const notes = new Map([["notes/keep.md", synthetic("Keep")], ["notes/absorb.md", absorbed], ["notes/research.md", "---\ntype: moc\ndescription: Synthetic directory.\n---\n# Research\n"]]);
  const changes = planMerge({ op: "merge", keep: "keep", absorb: "absorb" }, notes).changes;
  const keep = changes.find(change => change.path === "notes/keep.md")!.after!;
  expect(parseFrontmatter(keep).data.inferred_links).toEqual(["research"]);
  expect(keep).toContain("- [[research]]");
  const graph = buildGraph({ notes: [{ path: "keep.md", source: keep }, { path: "research.md", source: notes.get("notes/research.md")! }], today: "", logPath: "", log: null, registryIds: null, reports: {} });
  expect(graph.edges[0]?.confidence_tag).toBe("INFERRED");
});
