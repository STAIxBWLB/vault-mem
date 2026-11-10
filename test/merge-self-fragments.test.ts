import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault } from "../src/registry.ts";
import { applyWrite } from "../src/writer.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { VaultIndex } from "../src/vault-index.ts";

const roots: string[] = [];
const now = new Date(2026, 0, 2, 1);
const operation = { op: "merge" as const, keep: "keep", absorb: "absorb" };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function note(title: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: Synthetic evidence supporting fragment safety.\ntype: insight\ndomain: research\ntopics: ["[[research]]"]\nupdated: "2026-01-01"\n---\n# ${title}\n\n${body}\n\n## Topics\n\n- [[research]]\n`;
}
function fixture(keepBody: string, absorbBody: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vmem-merge-self-fragments-"))); roots.push(root);
  const home = join(root, "home"), vault = join(root, "vault"), notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "research.md"), "---\ntype: moc\ndescription: Synthetic research directory.\n---\n# Research\n");
  writeFileSync(join(notes, "keep.md"), note("Kept Finding", keepBody));
  writeFileSync(join(notes, "absorb.md"), note("Absorbed Finding", absorbBody));
  const spec = { id: "test", path: vault, kind: "personal" as const, write: "mcp" as const };
  addVault(home, spec);
  const merge = (fingerprint?: string) => applyWrite(home, { vault: "test", operation, ...(fingerprint !== undefined ? { confirm: true, fingerprint } : {}) }, { env: {}, now });
  return { root, home, vault, notes, spec, merge };
}
function disk(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    try { result[name] = readFileSync(join(root, name)).toString("base64"); } catch { /* Directories have no content. */ }
  }
  return result;
}

for (const kind of ["heading", "block"] as const) {
  const fragment = kind === "heading" ? "#Evidence" : "#^result";
  const absorbBody = `Follow [[${fragment}]].\n\n## Evidence\n\nAbsorbed evidence belongs here. ^result`;

  test(`merge refuses an absorbed fragment-only ${kind} self-link collision without changing files`, () => {
    const keepBody = kind === "heading" ? "## Evidence\n\nDifferent kept evidence." : "## Kept Context\n\nDifferent kept evidence. ^result";
    const f = fixture(keepBody, absorbBody), before = disk(f.root), result = f.merge();
    expect(result).toMatchObject({ ok: false, applied: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "V03", severity: "error" }));
    expect(result.issues.some(issue => issue.code === "V03" && /collid|collision/i.test(issue.message))).toBe(true);
    expect(result).not.toHaveProperty("merge");
    expect(disk(f.root)).toEqual(before);
  });

  test(`merge preserves an absorbed fragment-only ${kind} self-link when its anchor is unique`, () => {
    const f = fixture("## Kept Context\n\nKept evidence stays here. ^kept-result", absorbBody);
    const originalAbsorb = parseFrontmatter(readFileSync(join(f.notes, "absorb.md"), "utf8")), before = disk(f.root), preview = f.merge();
    expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
    expect(disk(f.root)).toEqual(before);
    expect(preview.merge!.body).toContain(`Follow [[${fragment}]].`);
    expect(preview.merge!.body).toContain("### Evidence\n\nAbsorbed evidence belongs here. ^result");
    const confirmed = f.merge(preview.fingerprint!);
    expect(confirmed).toMatchObject({ ok: true, applied: true });
    const keep = parseFrontmatter(readFileSync(join(f.notes, "keep.md"), "utf8")), absorb = parseFrontmatter(readFileSync(join(f.notes, "absorb.md"), "utf8"));
    expect(keep.body).toBe(preview.merge!.body);
    expect(keep.body).toContain(`[[${fragment}]]`);
    expect(absorb.body).toBe(originalAbsorb.body);
    expect(absorb.data).toMatchObject({ status: "superseded", superseded_by: "[[keep]]" });
    const index = new VaultIndex(f.home, f.spec);
    try {
      index.scan();
      const matches = index.links("keep").filter(link => link.target === "" && (kind === "heading" ? link.heading === "Evidence" : link.block === "result"));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ resolved: "keep.md", reason: null });
      const originalLinks = index.links("absorb").filter(link => link.target === "");
      expect(originalLinks).toHaveLength(1);
      expect(originalLinks[0]).toMatchObject({ resolved: "absorb.md", reason: null });
    } finally { index.close(); }
    expect(existsSync(join(f.notes, "absorb.md"))).toBe(true);
  });
}

test("merge ignores fake fragment-only collision references inside inline and fenced code", () => {
  const fake = "`[[#Evidence]] [[#^result]]`\n\n```md\n[[#Evidence]]\n[[#^result]]\n```";
  const f = fixture("## Evidence\n\nKept evidence. ^result", `## Evidence\n\nAbsorbed evidence. ^result\n\n${fake}`);
  const before = disk(f.root), preview = f.merge();
  expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
  expect(preview.merge!.body).toContain(fake);
  expect(disk(f.root)).toEqual(before);
  expect(f.merge(preview.fingerprint!)).toMatchObject({ ok: true, applied: true });
  expect(parseFrontmatter(readFileSync(join(f.notes, "keep.md"), "utf8")).body).toContain(fake);
});

test("merge checks a kept Setext collision after an ATX block exits a list", () => {
  const f = fixture("- item\n\n ## Boundary\nEvidence\n---", "Follow [[#Evidence]].\n\n## Evidence\n\nAbsorbed evidence.");
  const before = disk(f.root), preview = f.merge();
  expect(preview).toMatchObject({ ok: false, applied: false });
  expect(preview.issues).toContainEqual(expect.objectContaining({ code: "V03", severity: "error", message: expect.stringContaining("collid") }));
  expect(disk(f.root)).toEqual(before);
});

for (const reference of ["external", "self"] as const) test(`merge uses the reader's multiline Setext identity for an ${reference} absorbed fragment`, () => {
  const keepBody = "First heading line\nSecond heading line\n---\n\nKept evidence.";
  const absorbBody = `${reference === "self" ? "Follow [[#Second heading line]].\n\n" : ""}## Second heading line\n\nDifferent absorbed evidence.`;
  const f = fixture(keepBody, absorbBody);
  if (reference === "external") writeFileSync(join(f.notes, "peer.md"), note("External Finding", "Follow [[absorb#Second heading line]]."));
  const before = disk(f.root), preview = f.merge();
  expect(preview).toMatchObject({ ok: false, applied: false });
  expect(preview.issues).toContainEqual(expect.objectContaining({ code: "V03", severity: "error", message: expect.stringContaining("Second heading line") }));
  expect(preview.issues.some(issue => issue.code === "V03" && /collid|collision/i.test(issue.message))).toBe(true);
  expect(preview).not.toHaveProperty("merge");
  expect(disk(f.root)).toEqual(before);
});

for (const kind of ["heading", "block"] as const) {
  const fragment = kind === "heading" ? "#Evidence" : "#^result";
  const keepBody = kind === "heading" ? "## Evidence\n\nDifferent kept evidence." : "## Kept Context\n\nDifferent kept evidence. ^result";
  const absorbBody = "## Evidence\n\nAbsorbed evidence belongs here. ^result";

  test(`#190 a fragment-only ${kind} link in the removed leading title does not block merge`, () => {
    const f = fixture(keepBody, absorbBody), file = join(f.notes, "absorb.md");
    const original = readFileSync(file, "utf8").replace("# Absorbed Finding", `# Removed title [[${fragment}]]`);
    writeFileSync(file, original);
    const before = disk(f.root), preview = f.merge();
    expect(preview).toMatchObject({ ok: true, applied: false, preview: true });
    expect(disk(f.root)).toEqual(before);
    expect(preview.merge!.body).not.toContain("Removed title");
    expect(preview.merge!.body).not.toContain(`[[${fragment}]]`);
    expect(preview.merge!.body).toContain("### Evidence\n\nAbsorbed evidence belongs here. ^result");
    const mergeKeys = ["absorb", "body", "inboundLinks", "keep", "source", "topics"];
    expect(Object.keys(preview.merge!).sort()).toEqual(mergeKeys);
    expect(preview).not.toHaveProperty("copiedBody");
    const done = f.merge(preview.fingerprint!);
    expect(done).toMatchObject({ ok: true, applied: true });
    expect(Object.keys(done.merge!).sort()).toEqual(mergeKeys);
    expect(done).not.toHaveProperty("copiedBody");
    const keep = parseFrontmatter(readFileSync(join(f.notes, "keep.md"), "utf8")), absorb = parseFrontmatter(readFileSync(file, "utf8"));
    expect(keep.body).toBe(preview.merge!.body);
    expect(absorb.body).toBe(parseFrontmatter(original).body);
    expect(absorb.body).toContain(`# Removed title [[${fragment}]]`);
    expect(absorb.data).toMatchObject({ title: "Absorbed Finding", status: "superseded", superseded_by: "[[keep]]" });
    expect(existsSync(file)).toBe(true);
  });

  for (const location of ["later H1", "prose"] as const) test(`#190 a copied ${kind} fragment in ${location} still refuses even when the removed title had the same link`, () => {
    const copied = location === "later H1" ? `# Later title [[${fragment}]]` : `Follow [[${fragment}]] in copied prose.`;
    const f = fixture(keepBody, `${absorbBody}\n\n${copied}`), file = join(f.notes, "absorb.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("# Absorbed Finding", `# Removed title [[${fragment}]]`));
    const before = disk(f.root), result = f.merge();
    expect(result).toMatchObject({ ok: false, applied: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "V03", severity: "error", message: expect.stringContaining("collid") }));
    expect(result).not.toHaveProperty("merge");
    expect(disk(f.root)).toEqual(before);
  });
}
