import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { run } from "../src/cli.ts";
import { MIN_SUGGESTION_SCORE, VaultIndex } from "../src/vault-index.ts";
import { analysisInput } from "../src/analysis-input.ts";
import { lintVault } from "../src/vault-lint.ts";
import { createVaultMcp } from "../src/mcp-vault.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = (title: string, body: string, topics = "") => `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic fixture note.\ntype: insight\ndomain: research\n${topics}---\n${body}\n`;
// "Synthetic" sits in every title but the hub's, so a link text made only of it scores at or below zero.
const NOTES: Record<string, string> = {
  "alpha.md": note("Synthetic Alpha", "Alpha.", 'topics: ["[[Ghost Topic]]"]\n'),
  "beta.md": note("Synthetic Beta", "Beta."),
  "lantern.md": note("Synthetic Lantern Notes", "Lantern."),
  "vectors.md": note("Synthetic 벡터 검색", "Vectors."),
  "hub.md": note("Hub", [
    "# Hub", "",
    "Twice: [[Synthetic Lantern Notes]] and again [[Synthetic Lantern Notes]].",
    "Misses: [[Ghost Topic]] and [[Synthetic]].",
    "Korean: [[벡터 검색]].",
    "Resolved: [[alpha]].",
  ].join("\n")),
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-hints-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  for (const [path, text] of Object.entries(NOTES)) writeFileSync(join(notes, path), text);
  const spec = { id: "demo", path: vault, kind: "personal" as const, write: "cli" as const };
  addVault(home, spec);
  return { root, home, vault, notes, spec, env: { VMEM_HOME: home } };
}
/** Every path under root with its size and mtime, to prove a read wrote nothing there. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name), stat = lstatSync(file);
    out.push(`${file}:${stat.size}:${stat.mtimeMs}`);
    if (entry.isDirectory()) walk(file);
  } };
  walk(root); return out.sort();
}

test("#165 AC3: the title search offers the closest existing title, and the threshold drops a shared common word", () => {
  const f = fixture(), index = new VaultIndex(f.home, f.spec);
  try {
    index.scan();
    const hit = index.suggestTitle("Synthetic Lantern Notes")!;
    expect(hit).toMatchObject({ path: "lantern.md", title: "Synthetic Lantern Notes" });
    expect(hit.score).toBeGreaterThan(MIN_SUGGESTION_SCORE);
    expect(String(hit.score)).toMatch(/^\d+(\.\d{1,3})?$/);
    // One CJK run matches only through the bigram table, so a two-word Hangul title still resolves.
    expect(index.suggestTitle("벡터 검색")).toMatchObject({ path: "vectors.md", title: "Synthetic 벡터 검색" });
    // A miss: no title carries the words, so there is no hint and never a fallback to some other note.
    expect(index.suggestTitle("Ghost Topic")).toBeUndefined();
    expect(index.suggestTitle("   ")).toBeUndefined();
    // The threshold, not a missing match, is what rejects a word every title shares.
    expect(index.suggestTitle("Synthetic")).toBeUndefined();
    expect(index.suggestTitle("Synthetic", -1)!.score).toBeLessThan(MIN_SUGGESTION_SCORE);
  } finally { index.close(); }
});

test("#165 AC3: a snapshot carries at most one hint per dead link text and none for a resolved link", () => {
  const f = fixture(), hinted = analysisInput(f.home, "demo", { hints: true }).snapshot;
  expect(Object.keys(hinted.linkHints!).sort()).toEqual(["Synthetic Lantern Notes", "벡터 검색"].sort());
  // Frontmatter and body repeats of one text share one lookup, so `Ghost Topic` stays absent while `alpha` never appears.
  expect(hinted.linkHints).not.toHaveProperty("Ghost Topic");
  expect(hinted.linkHints).not.toHaveProperty("alpha");
  const suggestion = hinted.linkHints!["Synthetic Lantern Notes"]!;
  expect(existsSync(join(f.notes, suggestion.path))).toBe(true);
  // Without the option the pure lint transform sees no hints at all.
  const plain = analysisInput(f.home, "demo").snapshot;
  expect(plain).not.toHaveProperty("linkHints");
  expect(lintVault(plain).findings.L01.join("\n")).not.toContain("suggested");
  // With them, every L01 line for that text says suggested and gives the same score; the miss says nothing extra.
  const lines = lintVault(hinted).findings.L01.filter(line => line.includes("[[Synthetic Lantern Notes]]"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toContain("suggested `lantern.md` (score " + suggestion.score.toFixed(3) + ")");
  for (const line of lintVault(hinted).findings.L01.filter(l => l.includes("Ghost Topic") || l.includes("[[Synthetic]]"))) expect(line).not.toContain("suggested");
});

test("#165 AC3: lint and links report the hint in text and JSON and rewrite nothing", () => {
  const f = fixture(), before = tree(f.vault), lint = run(["lint", "demo"], f.env).text;
  expect(lint).toContain("suggested `lantern.md` (score ");
  expect(lint).toContain("벡터 검색");
  const links = JSON.parse(run(["links", "demo", "hub", "--json"], f.env).text) as { target: string; resolved: string | null; suggested: { path: string; score: number } | null }[];
  expect(links.find(l => l.target === "Synthetic Lantern Notes")).toMatchObject({ resolved: null, suggested: { path: "lantern.md" } });
  expect(links.find(l => l.target === "Ghost Topic")!.suggested).toBeNull();
  expect(links.find(l => l.target === "alpha")).toMatchObject({ resolved: "alpha.md" });
  expect(links.find(l => l.target === "alpha")).not.toHaveProperty("suggested");
  expect(run(["links", "demo", "hub"], f.env).text).toContain("suggested lantern.md (");
  // A hint is never a rewrite: the vault tree, note bytes and absence of a lock all stay as they were.
  expect(tree(f.vault)).toEqual(before);
  expect(existsSync(join(f.vault, "log.lock"))).toBe(false);
  expect(readdirSync(f.notes).sort()).toEqual(Object.keys(NOTES).sort());
});

test("#165 AC3: vmem_links and vmem_lint carry the same one hint over MCP", async () => {
  const f = fixture(), server = createVaultMcp(f.home, { VMEM_HOME: f.home });
  const links = await server.handlers.vmem_links!({ vault: "demo", path: "hub" }) as { out: { target: string }[]; dead: { target: string; suggested: { path: string; score: number } | null }[] };
  expect(links.dead.find(l => l.target === "Synthetic Lantern Notes")!.suggested).toMatchObject({ path: "lantern.md" });
  expect(links.dead.find(l => l.target === "Ghost Topic")!.suggested).toBeNull();
  expect(links.out.map(l => l.target)).toContain("alpha");
  const lint = JSON.stringify(await server.handlers.vmem_lint!({ vault: "demo" }));
  expect(lint).toContain("suggested `lantern.md`");
  expect(lint).not.toContain("suggested `alpha.md`");
});
